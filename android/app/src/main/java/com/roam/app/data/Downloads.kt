package com.roam.app.data

import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

/** A movie or episode saved on this device: what it is, and a manifest whose files are the saved copies (so it plays with no connection). */
@Serializable
data class DownloadRecord(
    val kind: String,
    val id: String,
    val name: String,
    val subtitle: String? = null,
    val version: String? = null,
    val bytes: Long = 0,
    val manifest: PlayManifest,
)

/** Where saved videos and their list are kept. */
interface DownloadStore {
    fun list(): List<DownloadRecord>
    fun get(kind: String, id: String): DownloadRecord? = list().firstOrNull { it.kind == kind && it.id == id }
    fun put(record: DownloadRecord)
    fun remove(kind: String, id: String)
    /** A place for this video's files. */
    fun folderFor(kind: String, id: String): File
}

class FileDownloadStore(private val root: File) : DownloadStore {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }
    private val index get() = File(root, "downloads.json")

    @Synchronized
    override fun list(): List<DownloadRecord> = runCatching { json.decodeFromString<List<DownloadRecord>>(index.readText()) }.getOrDefault(emptyList())

    @Synchronized
    override fun put(record: DownloadRecord) {
        root.mkdirs()
        val all = list().filterNot { it.kind == record.kind && it.id == record.id } + record
        index.writeText(json.encodeToString(all))
    }

    @Synchronized
    override fun remove(kind: String, id: String) {
        folderFor(kind, id).deleteRecursively()
        root.mkdirs()
        index.writeText(json.encodeToString(list().filterNot { it.kind == kind && it.id == id }))
    }

    override fun folderFor(kind: String, id: String) = File(root, "$kind-$id").apply { mkdirs() }
}

/** Progress of a save in progress, 0 to 1, or an error in words. */
data class DownloadState(val progress: Float = 0f, val error: String? = null)

/**
 * Saves videos to this device. A manifest (from the server, with its files' addresses) is downloaded part by part and, when it is all there,
 * recorded with local file addresses in place of the server's, so playing it needs no connection. Runs in [scope] (the app's, so it goes on
 * when the screen is left); a video not finished when the app is closed is simply started again.
 */
class DownloadManager(
    private val store: DownloadStore,
    private val scope: CoroutineScope,
    private val http: OkHttpClient = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build(),
) {
    private val _active = MutableStateFlow<Map<String, DownloadState>>(emptyMap())
    val active: StateFlow<Map<String, DownloadState>> = _active.asStateFlow()
    private val jobs = mutableMapOf<String, Job>()

    fun key(kind: String, id: String) = "$kind-$id"
    fun saved(): List<DownloadRecord> = store.list()
    fun record(kind: String, id: String): DownloadRecord? = store.get(kind, id)

    fun start(manifest: PlayManifest, kind: String, id: String, name: String, subtitle: String?, version: String?) {
        val k = key(kind, id)
        if (jobs[k]?.isActive == true || store.get(kind, id) != null) return
        _active.update { it + (k to DownloadState()) }
        jobs[k] = scope.launch(Dispatchers.IO) {
            try {
                val folder = store.folderFor(kind, id)
                val total = manifest.segments.sumOf { it.sizeBytes ?: 0L }.coerceAtLeast(1L)
                var done = 0L
                val local = manifest.segments.mapIndexed { i, seg ->
                    val file = File(folder, "part$i.${seg.container?.takeIf { it.isNotBlank() } ?: "mp4"}")
                    done += fetch(seg.url, file) { read -> _active.update { it + (k to DownloadState(((done + read).toFloat() / total).coerceAtMost(0.99f))) } }
                    seg.copy(url = file.toURI().toString())
                }
                store.put(DownloadRecord(kind, id, name, subtitle, version, done, manifest.copy(segments = local, versions = emptyList(), version = version, heartbeat = false)))
                _active.update { it - k }
            } catch (e: Exception) {
                if (!isActive) return@launch
                store.folderFor(kind, id).deleteRecursively()
                _active.update { it + (k to DownloadState(error = if (e is IOException) "The download stopped: ${e.message ?: "no connection"}." else "The download failed.")) }
            }
        }
    }

    fun cancel(kind: String, id: String) {
        val k = key(kind, id)
        jobs.remove(k)?.cancel()
        store.folderFor(kind, id).deleteRecursively()
        _active.update { it - k }
    }

    fun remove(kind: String, id: String) {
        cancel(kind, id)
        store.remove(kind, id)
    }

    fun dismissError(kind: String, id: String) = _active.update { it - key(kind, id) }

    /** Writes one file from an address, reporting bytes so far; returns its size. */
    private suspend fun fetch(url: String, to: File, onBytes: (Long) -> Unit): Long = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("the server answered ${r.code}")
            val body = r.body ?: throw IOException("an empty answer")
            to.outputStream().use { out ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                body.byteStream().use { input ->
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        total += n
                        onBytes(total)
                        if (!isActive) throw IOException("cancelled")
                    }
                }
                total
            }
        }
    }
}

/** For tests and previews: the same API with nothing saved and nothing downloaded. */
class NoDownloads : DownloadStore {
    override fun list() = emptyList<DownloadRecord>()
    override fun put(record: DownloadRecord) = Unit
    override fun remove(kind: String, id: String) = Unit
    override fun folderFor(kind: String, id: String) = File(System.getProperty("java.io.tmpdir"), "roam-no-downloads").apply { mkdirs() }
}
