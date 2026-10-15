package com.roam.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Accent = Color(0xFF2DD4BF)
private val Dark = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF0B0B10),
    background = Color(0xFF0B0B10),
    onBackground = Color(0xFFECECF1),
    surface = Color(0xFF14141C),
    onSurface = Color(0xFFECECF1),
    surfaceVariant = Color(0xFF1B1B25),
    onSurfaceVariant = Color(0xFFB8B8C4),
    error = Color(0xFFFF6B6B),
)

@Composable
fun RoamTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = Dark, content = content)
