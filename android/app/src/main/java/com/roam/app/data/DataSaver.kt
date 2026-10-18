package com.roam.app.data

/**
 * Data saver on this device. The profile has its own setting (the server applies it); a phone can also follow the connection, so it asks the
 * server for data saver while on mobile data (a metered connection) and not on Wi-Fi.
 */
object DataSaver {
    val MODES = listOf("profile", "auto", "on", "off")

    /** What to send the server with a play request: "1" (on), "0" (off), or null to let the profile's own setting apply. */
    fun param(mode: String, metered: Boolean?): String? = when (mode) {
        "on" -> "1"
        "off" -> "0"
        "auto" -> metered?.let { if (it) "1" else "0" }
        else -> null
    }

    fun label(mode: String): String = when (mode) {
        "auto" -> "Automatic (on mobile data)"
        "on" -> "Always on"
        "off" -> "Always off"
        else -> "Same as my profile"
    }
}
