package com.roam.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.roam.app.data.RoamImages

class RoamApplication : Application(), ImageLoaderFactory {
    val graph: AppGraph by lazy { AppGraph.create(this) }

    /** Pictures that come from Roam itself (photos) are fetched with the sign-in; the rest (posters) are ordinary web pictures. */
    override fun newImageLoader(): ImageLoader = RoamImages.loader(this, { graph.serverUrl }, { graph.settings.token })
}
