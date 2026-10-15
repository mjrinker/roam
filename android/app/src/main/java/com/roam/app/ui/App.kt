package com.roam.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.roam.app.LocalGraph

/** The whole app: the screens and how they lead to one another. */
@Composable
fun RoamApp(navController: NavHostController = rememberNavController()) {
    val graph = LocalGraph.current
    val nav = remember(navController) {
        object : Nav {
            override fun open(route: String) = navController.navigate(route)
            override fun back() {
                navController.popBackStack()
            }
            override fun signedOut() {
                graph.settings.signOutLocally()
                navController.navigate(Routes.SIGN_IN) { popUpTo(0) { inclusive = true } }
            }
        }
    }
    val toHome: (String) -> Unit = { sid -> navController.navigate(Routes.home(sid)) { popUpTo(0) { inclusive = true } } }

    RoamTheme {
        NavHost(navController, startDestination = if (graph.settings.token == null) Routes.SIGN_IN else Routes.gate()) {
            composable(Routes.SIGN_IN) {
                SignInScreen(nav, onSignedIn = { navController.navigate(Routes.gate()) { popUpTo(0) { inclusive = true } } })
            }
            composable(Routes.GATE, arguments = listOf(navArgument("force") { type = NavType.BoolType; defaultValue = false })) { e ->
                GateScreen(nav, force = e.arguments?.getBoolean("force") == true, onReady = toHome)
            }
            composable(Routes.HOME) { e -> HomeScreen(e.arguments!!.getString("sid")!!, nav) }
            composable(Routes.LIBRARY) { e ->
                val a = e.arguments!!
                LibraryScreen(a.getString("sid")!!, a.getString("lid")!!, a.getString("style")!!, a.getString("name")!!, nav)
            }
            composable(Routes.TITLE) { e -> TitleScreen(e.arguments!!.getString("sid")!!, e.arguments!!.getString("id")!!, nav) }
            composable(Routes.ALBUM) { e -> AlbumScreen(e.arguments!!.getString("sid")!!, e.arguments!!.getString("id")!!, nav) }
            composable(Routes.ARTIST) { e -> ArtistScreen(e.arguments!!.getString("sid")!!, e.arguments!!.getString("id")!!, nav) }
            composable(Routes.SEARCH) { e -> SearchScreen(e.arguments!!.getString("sid")!!, nav) }
            composable(Routes.PHOTO, arguments = listOf(navArgument("from") { type = NavType.StringType; defaultValue = "timeline" })) { e ->
                PhotoScreen(e.arguments!!.getString("sid")!!, e.arguments!!.getString("id")!!, e.arguments!!.getString("from") ?: "timeline", nav)
            }
            composable(Routes.PLAYLISTS) { e -> PlaylistsScreen(e.arguments!!.getString("sid")!!, nav) }
            composable(Routes.PLAYLIST) { e -> PlaylistScreen(e.arguments!!.getString("sid")!!, e.arguments!!.getString("id")!!, nav) }
            composable(Routes.NOTIFICATIONS) { NotificationsScreen(nav) }
            composable(Routes.ACCOUNT) { AccountScreen(nav, onSwitchProfile = { nav.open(Routes.gate(force = true)) }) }
            composable(
                Routes.PLAYER,
                arguments = listOf(
                    navArgument("name") { type = NavType.StringType; defaultValue = "" },
                    navArgument("startOver") { type = NavType.BoolType; defaultValue = false },
                    navArgument("startAt") { type = NavType.FloatType; defaultValue = -1f },
                    navArgument("queue") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { e ->
                val a = e.arguments!!
                val queue = a.getString("queue").orEmpty().split(",").filter { it.isNotBlank() }
                PlayerScreen(
                    kind = a.getString("kind")!!, id = a.getString("id")!!, name = a.getString("name").orEmpty(),
                    startOver = a.getBoolean("startOver"), startAt = a.getFloat("startAt").toDouble().takeIf { it >= 0 }, queue = queue, nav = nav,
                    onNext = { next, rest ->
                        navController.popBackStack()
                        navController.navigate(Routes.player(a.getString("kind")!!, next, a.getString("name").orEmpty(), queue = rest))
                    },
                )
            }
            composable(Routes.AUDIO, arguments = listOf(navArgument("name") { type = NavType.StringType; defaultValue = "" }, navArgument("remember") { type = NavType.BoolType; defaultValue = false })) { e ->
                AudioScreen(e.arguments!!.getString("id")!!, e.arguments!!.getString("name").orEmpty(), e.arguments!!.getBoolean("remember"), nav)
            }
        }
    }
}
