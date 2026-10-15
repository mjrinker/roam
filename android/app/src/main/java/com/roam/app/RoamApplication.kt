package com.roam.app

import android.app.Application

class RoamApplication : Application() {
    val graph: AppGraph by lazy { AppGraph.create(this) }
}
