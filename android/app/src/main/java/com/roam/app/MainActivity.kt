package com.roam.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import com.roam.app.ui.RoamApp

class MainActivity : ComponentActivity() {
    // The app is already open (it is "singleTask"): a new request arrives here.
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        PendingRoute.route = DeepLink.routeFor(intent, (application as RoamApplication).graph.settings.serverId) ?: PendingRoute.route
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = (application as RoamApplication).graph
        PendingRoute.route = DeepLink.routeFor(intent, graph.settings.serverId) ?: PendingRoute.route
        setContent {
            CompositionLocalProvider(LocalGraph provides graph) { RoamApp() }
        }
    }
}
