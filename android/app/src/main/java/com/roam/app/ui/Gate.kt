package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.Me
import com.roam.app.data.ProfileSummary
import com.roam.app.data.ServerSummary
import kotlinx.coroutines.launch

/** What stands between signing in and the home screen: who's watching (with a PIN where there is one), and which server. */
@Composable
fun GateScreen(nav: Nav, force: Boolean, onReady: (serverId: String) -> Unit) {
    val graph = LocalGraph.current
    val loader = rememberLoader(force) { graph.api.me() }
    LoadView(loader, nav) { me ->
        var chosen by remember(me) { mutableStateOf(me.profile != null && !force) }
        if (!chosen) {
            ProfilesScreen(me, onChosen = { chosen = true })
        } else {
            ServerStep(nav, onReady)
        }
    }
}

@Composable
fun ProfilesScreen(me: Me, onChosen: () -> Unit) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var asking by remember { mutableStateOf<ProfileSummary?>(null) }
    var pin by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }

    fun choose(profile: ProfileSummary, pinValue: String?) {
        scope.launch {
            try {
                graph.api.chooseProfile(profile.id, pinValue)
                asking = null
                pin = ""
                onChosen()
            } catch (e: ApiException) {
                problem = when {
                    e.code == "incorrect_pin" -> "That PIN isn't right."
                    e.status == 429 -> "Too many tries. Wait a few minutes."
                    e.status == 0 -> "Roam can't be reached."
                    else -> e.message
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(48.dp), verticalArrangement = Arrangement.Center) {
        Text("Who's watching?", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onBackground)
        Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            for (p in me.profiles) {
                Row(
                    Modifier.fillMaxWidth().focusRing().clickable { problem = null; if (p.hasPin) asking = p else choose(p, null) }.padding(20.dp).testTag("profile-${p.id}"),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(p.name, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
                    if (p.hasPin) Text("PIN", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        problem?.let { if (asking == null) Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
    }

    asking?.let { profile ->
        AlertDialog(
            onDismissRequest = { asking = null; pin = ""; problem = null },
            title = { Text("PIN for ${profile.name}") },
            text = {
                Column {
                    OutlinedTextField(
                        value = pin, onValueChange = { if (it.length <= 4 && it.all(Char::isDigit)) pin = it }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.testTag("pin"),
                    )
                    problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("pin-problem")) }
                }
            },
            confirmButton = { Button(enabled = pin.length == 4, onClick = { choose(profile, pin) }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { asking = null; pin = ""; problem = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ServerStep(nav: Nav, onReady: (String) -> Unit) {
    val graph = LocalGraph.current
    val loader = rememberLoader { graph.api.servers() }
    LoadView(loader, nav) { servers ->
        val saved = graph.settings.serverId
        val pick: ServerSummary? = servers.firstOrNull { it.id == saved } ?: servers.singleOrNull()
        if (servers.isEmpty()) {
            Centered { Text("You're not in any servers yet. Join or create one in Roam on a phone or computer.", color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.padding(32.dp)) }
        } else if (pick != null) {
            LaunchedEffect(pick.id) {
                graph.settings.serverId = pick.id
                onReady(pick.id)
            }
        } else {
            Column(Modifier.fillMaxSize().padding(48.dp), verticalArrangement = Arrangement.Center) {
                Text("Choose a server", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onBackground)
                Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (s in servers) {
                        Text(
                            s.name, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground,
                            modifier = Modifier.fillMaxWidth().focusRing().clickable { graph.settings.serverId = s.id; onReady(s.id) }.padding(20.dp).testTag("server-${s.id}"),
                        )
                    }
                }
            }
        }
    }
}
