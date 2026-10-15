package com.roam.app.data

import android.content.Context
import coil.ImageLoader
import coil.map.Mapper
import coil.request.Options
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response

/** How the app fetches pictures: an address that is only a path ("/api/photos/…") is Roam's own, so it goes to the server with the sign-in. */
object RoamImages {
    /** The address a picture is fetched from: paths are Roam's, whole addresses are left as they are. */
    fun resolve(base: String, url: String): String = if (url.startsWith("/") && !url.startsWith("//")) base.trimEnd('/') + url else url

    /** Adds the sign-in to a request, only when it goes to Roam's own server (never to a poster host). */
    fun authorize(base: String, token: String?, url: HttpUrl): String? {
        val server = base.toHttpUrlOrNull() ?: return null
        return if (token != null && url.host == server.host && url.port == server.port && url.scheme == server.scheme) "Bearer $token" else null
    }

    fun loader(context: Context, base: () -> String, token: () -> String?): ImageLoader {
        val client = OkHttpClient.Builder().addInterceptor(Interceptor { chain: Interceptor.Chain ->
            val request = chain.request()
            val header = authorize(base(), token(), request.url)
            val response: Response = chain.proceed(if (header == null) request else request.newBuilder().header("Authorization", header).build())
            response
        }).build()
        return ImageLoader.Builder(context)
            .okHttpClient(client)
            .components { add(Mapper<String, HttpUrl> { data, _: Options -> if (data.startsWith("/") && !data.startsWith("//")) resolve(base(), data).toHttpUrlOrNull() else null }) }
            .crossfade(true)
            .build()
    }
}
