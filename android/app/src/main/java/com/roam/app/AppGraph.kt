package com.roam.app

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import androidx.compose.runtime.staticCompositionLocalOf
import com.roam.app.data.AndroidSettings
import com.roam.app.data.HttpRoamApi
import com.roam.app.data.RoamApi
import com.roam.app.data.Settings
import com.roam.app.player.AudioSupport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** What the screens share: the saved settings, the API, and facts about this device. Tests build their own with fakes. */
class AppGraph(
    val settings: Settings,
    val api: RoamApi,
    val isTv: Boolean,
    /** The audio formats this device can't play (asked of the server so it can convert), comma separated. */
    val unsupportedAudio: () -> String = { "" },
    val clockMs: () -> Long = System::currentTimeMillis,
    val deviceName: String = "Android",
    /** For work that has to finish even when the screen that asked for it is gone (telling Roam where you stopped). */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    val push: com.roam.app.push.PushRegistrar = com.roam.app.push.NoPush,
) {
    val serverUrl: String get() = settings.serverUrl ?: BuildConfig.DEFAULT_SERVER

    companion object {
        fun create(context: Context): AppGraph {
            val settings = AndroidSettings(context)
            val api = HttpRoamApi({ settings.serverUrl ?: BuildConfig.DEFAULT_SERVER }, { settings.token })
            val tv = (context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
                context.packageManager.hasSystemFeature("android.software.leanback") ||
                context.packageManager.hasSystemFeature("amazon.hardware.fire_tv")
            return AppGraph(
                settings, api, tv,
                unsupportedAudio = { AudioSupport.unsupported(AudioSupport.deviceCanPlay(context)) },
                deviceName = android.os.Build.MODEL ?: "Android",
                push = com.roam.app.push.FcmPush(context),
            )
        }
    }
}

val LocalGraph = staticCompositionLocalOf<AppGraph> { error("No AppGraph provided") }
