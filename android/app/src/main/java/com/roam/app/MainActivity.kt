package com.roam.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import com.roam.app.ui.RoamApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = (application as RoamApplication).graph
        setContent {
            CompositionLocalProvider(LocalGraph provides graph) { RoamApp() }
        }
    }
}
