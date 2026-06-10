package app.clawkietalkie.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import app.clawkietalkie.R

// Dark OLED-first runtime tokens. Mirror of the web client's `src/tokens.ts`.

object Hifi {
    val bg = Color(0xFF000000)
    val surface = Color(0xFF0C0C0E)
    val surface2 = Color(0xFF151518)
    val stroke = Color.White.copy(alpha = 0.1f)
    val strokeStrong = Color.White.copy(alpha = 0.22f)
    val ink = Color(0xFFFAFAFA)
    val ink2 = Color(0xFFC4C4C8)
    val ink3 = Color(0xFF8C8C94)
    val ink4 = Color(0xFF5C5C62)

    val ai = Color(0xFF7FB8D0)
    val aiGlow = Color(0xFF7FB8D0).copy(alpha = 0.4f)
    val think = Color(0xFFE8C25A)
    val thinkGlow = Color(0xFFE8C25A).copy(alpha = 0.4f)

    val errorRed = Color(0xFFEF6155)

    data class Accent(val rec: Color, val recGlow: Color)

    val accents: Map<String, Accent> = mapOf(
        "amber" to Accent(Color(0xFFFF9E3B), Color(0xFFFF9E3B).copy(alpha = 0.45f)),
        "red" to Accent(Color(0xFFFF5A4A), Color(0xFFFF5A4A).copy(alpha = 0.45f)),
        "cyan" to Accent(Color(0xFF5AD0E8), Color(0xFF5AD0E8).copy(alpha = 0.45f)),
        "green" to Accent(Color(0xFF4ED29A), Color(0xFF4ED29A).copy(alpha = 0.45f)),
        "magenta" to Accent(Color(0xFFE866C6), Color(0xFFE866C6).copy(alpha = 0.45f)),
    )

    val mono = FontFamily(
        Font(R.font.ibm_plex_mono_regular, FontWeight.Normal),
        Font(R.font.ibm_plex_mono_medium, FontWeight.Medium),
        Font(R.font.ibm_plex_mono_semibold, FontWeight.SemiBold),
        Font(R.font.ibm_plex_mono_bold, FontWeight.Bold),
    )

    val sans = FontFamily(
        Font(R.font.ibm_plex_sans_regular, FontWeight.Normal),
        Font(R.font.ibm_plex_sans_medium, FontWeight.Medium),
        Font(R.font.ibm_plex_sans_semibold, FontWeight.SemiBold),
        Font(R.font.ibm_plex_sans_bold, FontWeight.Bold),
    )
}

/** CSS hex-suffix alpha equivalent: `${color}55` → color.a(0x55). */
fun Color.a(hexByte: Int): Color = copy(alpha = hexByte / 255f)
