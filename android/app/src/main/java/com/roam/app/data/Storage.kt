package com.roam.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** What the app remembers between runs: the device token (kept encrypted), the server's address, and which server and profile were chosen. */
interface Settings {
    var token: String?
    var serverUrl: String?
    var serverId: String?
    /** Data saver on this device: "profile" (the profile's own setting), "auto" (on while the connection is metered), "on" or "off". */
    var dataSaverMode: String
    fun signOutLocally() {
        token = null
        serverId = null
    }
}

class MemorySettings(override var token: String? = null, override var serverUrl: String? = null, override var serverId: String? = null, override var dataSaverMode: String = "profile") : Settings

class AndroidSettings(context: Context) : Settings {
    private val plain: SharedPreferences = context.getSharedPreferences("roam", Context.MODE_PRIVATE)
    // The token is kept only encrypted. Some devices lose their key store (a restore, a broken update): then it is kept in memory for this run
    // (sign in again next time) rather than ever being written in the clear.
    private val secret: SharedPreferences? = try {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(context, "roam_secret", key, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    } catch (e: Exception) {
        context.deleteSharedPreferences("roam_secret")
        null
    }
    private var memoryToken: String? = null

    override var token: String?
        get() = if (secret != null) secret.getString("token", null) else memoryToken
        set(value) {
            if (secret == null) memoryToken = value else secret.edit().apply { if (value == null) remove("token") else putString("token", value) }.apply()
        }
    override var serverUrl: String?
        get() = plain.getString("serverUrl", null)
        set(value) = plain.edit().apply { if (value == null) remove("serverUrl") else putString("serverUrl", value) }.apply()
    override var dataSaverMode: String
        get() = plain.getString("dataSaverMode", null)?.takeIf { it in DataSaver.MODES } ?: "profile"
        set(value) = plain.edit().putString("dataSaverMode", value).apply()
    override var serverId: String?
        get() = plain.getString("serverId", null)
        set(value) = plain.edit().apply { if (value == null) remove("serverId") else putString("serverId", value) }.apply()
}
