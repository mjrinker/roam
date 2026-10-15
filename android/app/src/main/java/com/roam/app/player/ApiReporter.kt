package com.roam.app.player

import com.roam.app.data.ApiException
import com.roam.app.data.RoamApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Tells Roam where the person is, in the background (a failure never interrupts the film). */
class ApiReporter(
    private val api: RoamApi,
    private val kind: String,
    private val id: String,
    private val scope: CoroutineScope,
) : Reporter {
    override fun saveProgress(positionSeconds: Int, durationSeconds: Int, finished: Boolean) {
        scope.launch { runCatching { api.saveProgress(kind, id, positionSeconds, durationSeconds, finished) } }
    }

    override fun beat(paused: Boolean, onLost: (String) -> Unit) {
        scope.launch {
            try {
                api.beat(kind, id, paused)
            } catch (e: ApiException) {
                if (e.status == 423) withContext(Dispatchers.Main) { onLost(e.message) }
            }
        }
    }

    override fun end() {
        scope.launch { runCatching { api.endPlay() } }
    }
}
