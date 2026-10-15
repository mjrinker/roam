package com.roam.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.DeviceStart
import kotlinx.coroutines.delay

/**
 * Signing in with a code: this screen shows five characters and an address; the person types the code there, on a phone or computer where they
 * are signed in, and this screen notices and moves on. Nobody types a password here.
 */
@Composable
fun SignInScreen(nav: Nav, onSignedIn: () -> Unit) {
    val graph = LocalGraph.current
    var attempt by remember { mutableIntStateOf(0) }
    var start by remember { mutableStateOf<DeviceStart?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf(graph.serverUrl) }

    LaunchedEffect(attempt) {
        problem = null
        start = null
        val started = try {
            graph.api.startDevice(graph.deviceName)
        } catch (e: ApiException) {
            problem = if (e.status == 0) "Roam can't be reached. Check the network connection and the server address." else e.message
            return@LaunchedEffect
        }
        start = started
        val deadline = graph.clockMs() + started.expiresIn * 1000L
        while (graph.clockMs() < deadline) {
            delay(started.interval.coerceAtLeast(2) * 1000L)
            val answer = try {
                graph.api.pollDevice(started.deviceCode)
            } catch (e: ApiException) {
                if (e.status in listOf(0, 429, 500, 502, 503)) continue else { problem = e.message; return@LaunchedEffect }
            }
            if (answer.status == "approved" && answer.accessToken != null) {
                graph.settings.token = answer.accessToken
                onSignedIn()
                return@LaunchedEffect
            }
            if (answer.status == "expired") break
        }
        attempt++ // the code ran out: a new one
    }

    Column(Modifier.fillMaxSize().padding(48.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.Start) {
        Text("Sign in to Roam", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onBackground)
        Text(
            "On a phone or computer, go to ${start?.verificationUrl ?: graph.serverUrl.trimEnd('/') + "/link"} and sign in. Then type this code:",
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp),
        )
        Text(
            start?.userCode ?: "· · · · ·",
            fontSize = 64.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, letterSpacing = 12.sp,
            modifier = Modifier.padding(vertical = 20.dp).testTag("code"),
        )
        Text("This screen signs in by itself when you approve the code.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp).testTag("problem")) }
        Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (problem != null) Button(onClick = { attempt++ }) { Text("Try again") }
            TextButton(onClick = { editing = !editing }) { Text(if (editing) "Hide the server address" else "Change the server address") }
            if (editing) {
                OutlinedTextField(
                    value = address, onValueChange = { address = it }, singleLine = true, label = { Text("Server address") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.testTag("address"),
                )
                Button(onClick = {
                    val cleaned = address.trim().trimEnd('/')
                    if (cleaned.startsWith("https://") || cleaned.startsWith("http://localhost")) {
                        graph.settings.serverUrl = cleaned
                        attempt++
                    } else problem = "The address has to start with https://"
                }) { Text("Use this address") }
            }
        }
    }
}
