package com.roam.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** A screen that something outside the app asked for, until the navigation has gone there. */
object PendingRoute {
    var route by mutableStateOf<String?>(null)
}
