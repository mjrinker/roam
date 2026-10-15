package com.roam.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.roam.app.MainActivity
import com.roam.app.R
import com.roam.app.RoamApplication
import com.roam.app.data.ApiException
import com.roam.app.data.RoamApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** Tells Roam where to send this device's notifications. A build without Firebase set up has none (and notifications are only the list in the app). */
interface PushRegistrar {
    /** Whether this build can receive pushes at all. */
    val available: Boolean

    /** Gives Roam this device's current registration; failures are quietly ignored (it is tried again next time the app opens). */
    suspend fun register(api: RoamApi)
}

object NoPush : PushRegistrar {
    override val available = false
    override suspend fun register(api: RoamApi) = Unit
}

class FcmPush(private val context: Context) : PushRegistrar {
    override val available: Boolean get() = FirebaseApp.getApps(context).isNotEmpty()

    override suspend fun register(api: RoamApi) {
        if (!available) return
        val token = suspendCancellableCoroutine<String?> { cont ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { cont.resume(if (it.isSuccessful) it.result else null) }
        } ?: return
        try {
            api.registerPush(token)
        } catch (_: ApiException) {
        }
    }
}

const val CHANNEL = "roam_notifications"

/** Shows what Roam sent, whether the app was open or not (a message that arrives while the app is closed is shown by the system itself). */
class PushMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val graph = (application as RoamApplication).graph
        if (graph.settings.token == null) return // not signed in: nothing to register for
        graph.appScope.launch {
            try {
                graph.api.registerPush(token)
            } catch (_: ApiException) {
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification ?: return
        show(this, n.title ?: "Roam", n.body.orEmpty())
    }
}

fun show(context: Context, title: String, body: String) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (android.os.Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_DEFAULT))
    val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body).setContentIntent(open).setAutoCancel(true).build()
    runCatching { manager.notify(System.currentTimeMillis().toInt(), notification) } // without the permission it is simply not shown
}
