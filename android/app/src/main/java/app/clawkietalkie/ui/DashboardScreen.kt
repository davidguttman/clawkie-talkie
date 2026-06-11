package app.clawkietalkie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.protocol.NewSessionCreateInput
import app.clawkietalkie.protocol.NewSessionDestinationOption
import app.clawkietalkie.protocol.NewSessionDestinationProvider
import app.clawkietalkie.protocol.NewSessionDestinationsCatalog
import app.clawkietalkie.protocol.PhoneToDaemon
import app.clawkietalkie.protocol.RecentSession
import app.clawkietalkie.protocol.decodeRecentSession
import app.clawkietalkie.protocol.webOnlyNewSessionDestinationsCatalog
import app.clawkietalkie.rtc.RecentSessionsSupportStatus
import app.clawkietalkie.rtc.RtcSession
import app.clawkietalkie.rtc.RtcStatus
import app.clawkietalkie.storage.RecentSessionFavoriteState
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

// Recent-sessions dashboard. Mirror of the web client's Dashboard.tsx.

private const val DASHBOARD_REFRESH_TIMEOUT_MS = 12_000L

private enum class RefreshPhase { IDLE, LOADING, REFRESHING }

@Composable
fun DashboardScreen(
    rtc: RtcSession,
    onSwitchHost: () -> Unit,
    onSelectSession: (RecentSession) -> Unit,
    onNewSessionCreated: (RecentSession) -> Unit,
    onHistory: () -> Unit,
    onSettings: () -> Unit,
    compact: Boolean,
) {
    val rtcState by rtc.state.collectAsState()
    var refreshPhase by remember { mutableStateOf(RefreshPhase.IDLE) }
    var refreshRequestId by remember { mutableStateOf(0) }
    var timedOut by remember { mutableStateOf(false) }
    var newSessionOpen by remember { mutableStateOf(false) }

    fun requestSessions(phase: RefreshPhase) {
        refreshPhase = phase
        refreshRequestId += 1
        timedOut = false
        rtc.requestRecentSessions()
    }

    // Request once when the connection opens; the session also subscribes,
    // but this makes the dashboard eager when opened from the launcher.
    LaunchedEffect(rtcState.status) {
        if (rtcState.status == RtcStatus.OPEN &&
            rtcState.recentSessionsSupportStatus != RecentSessionsSupportStatus.UNSUPPORTED
        ) {
            requestSessions(RefreshPhase.LOADING)
        }
    }

    LaunchedEffect(rtcState.status, rtcState.newSessionsSupported) {
        if (rtcState.status == RtcStatus.OPEN && rtcState.newSessionsSupported) {
            rtc.requestNewSessionDestinations()
        }
    }

    LaunchedEffect(rtcState.newSessionsSupported) {
        if (!rtcState.newSessionsSupported) newSessionOpen = false
    }

    LaunchedEffect(rtcState.recentSessionsResponseSeq) {
        if (rtcState.recentSessionsResponseSeq > 0) {
            refreshPhase = RefreshPhase.IDLE
            timedOut = false
        }
    }

    LaunchedEffect(refreshPhase, refreshRequestId) {
        if (refreshPhase == RefreshPhase.IDLE) return@LaunchedEffect
        delay(DASHBOARD_REFRESH_TIMEOUT_MS)
        if (refreshPhase != RefreshPhase.IDLE) {
            refreshPhase = RefreshPhase.IDLE
            timedOut = true
        }
    }

    val waiting = refreshPhase != RefreshPhase.IDLE
    val connectionLabel = formatConnectionLabel(rtcState.status, rtcState.detail)
    val updatedLabel = formatUpdatedAt(rtcState.recentSessionsGeneratedAt)
    val supportStatus = rtcState.recentSessionsSupportStatus
    val hasResponse = rtcState.recentSessions.isNotEmpty() || rtcState.recentSessionsGeneratedAt != null
    val showUnsupported = supportStatus == RecentSessionsSupportStatus.UNSUPPORTED && !hasResponse
    val showTimedOut = timedOut && !hasResponse
    val rendezvousDetail = formatDaemonRendezvousDetail(rtcState.detail)
    val showError = rendezvousDetail != null && rtcState.status != RtcStatus.OPEN

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(
                start = if (compact) 10.dp else 20.dp,
                end = if (compact) 10.dp else 20.dp,
                top = if (compact) 12.dp else 18.dp,
                bottom = if (compact) 14.dp else 18.dp,
            ),
        verticalArrangement = Arrangement.spacedBy(if (compact) 12.dp else 16.dp),
    ) {
        // Header
        Row(verticalAlignment = Alignment.Top) {
            Text(
                text = "Recent Sessions",
                fontSize = if (compact) 26.sp else 30.sp,
                lineHeight = if (compact) 27.sp else 31.sp,
                letterSpacing = (-0.8).sp,
                color = Hifi.ink,
                fontFamily = Hifi.sans,
                modifier = Modifier.weight(1f),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (rtcState.newSessionsSupported) {
                    Box(
                        modifier = Modifier
                            .widthIn(min = if (compact) 56.dp else 64.dp)
                            .height(34.dp)
                            .border(1.dp, Hifi.ai.a(0x66), RoundedCornerShape(12.dp))
                            .background(Hifi.ai.a(0x14), RoundedCornerShape(12.dp))
                            .clickable {
                                newSessionOpen = true
                                rtc.requestNewSessionDestinations()
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "NEW",
                            fontFamily = Hifi.mono,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.1.sp,
                            color = Hifi.ai,
                            modifier = Modifier.padding(horizontal = 10.dp),
                        )
                    }
                }
                Box(
                    modifier = Modifier
                        .widthIn(min = if (compact) 76.dp else 84.dp)
                        .height(34.dp)
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(12.dp))
                        .clickable { onHistory() },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "HISTORY",
                        fontFamily = Hifi.mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.1.sp,
                        color = Hifi.ink2,
                        modifier = Modifier.padding(horizontal = 10.dp),
                    )
                }
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(12.dp))
                        .clickable { onSettings() },
                    contentAlignment = Alignment.Center,
                ) {
                    Text("⚙", fontSize = 16.sp, color = Hifi.ink2)
                }
            }
        }

        // Daemon connection card
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, Hifi.stroke, RoundedCornerShape(16.dp))
                .background(Color.White.copy(alpha = 0.035f), RoundedCornerShape(16.dp))
                .padding(if (compact) 10.dp else 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ConnectionStatusPill(status = rtcState.status, label = connectionLabel)
                val canRefresh = rtcState.canRetryConnection || (!waiting && rtcState.status == RtcStatus.OPEN)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // The web switches hosts via the address bar URL; this pill is
                // the Android equivalent and is always available, including
                // while disconnected.
                Box(
                    modifier = Modifier
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(999.dp))
                        .background(Color.White.copy(alpha = 0.06f), RoundedCornerShape(999.dp))
                        .clickable { onSwitchHost() }
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                ) {
                    Text(
                        text = "SWITCH HOST",
                        fontFamily = Hifi.mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.1.sp,
                        color = Hifi.ink,
                    )
                }
                Box(
                    modifier = Modifier
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(999.dp))
                        .background(
                            if (waiting && !rtcState.canRetryConnection) Color.White.copy(alpha = 0.04f)
                            else Color.White.copy(alpha = 0.06f),
                            RoundedCornerShape(999.dp),
                        )
                        .let { if (canRefresh) it.clickable {
                            if (rtcState.canRetryConnection) rtc.retryConnection()
                            else requestSessions(
                                if (rtcState.recentSessionsGeneratedAt != null) RefreshPhase.REFRESHING
                                else RefreshPhase.LOADING,
                            )
                        } else it }
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                ) {
                    Text(
                        text = when {
                            rtcState.canRetryConnection -> "RECONNECT"
                            waiting -> "REFRESHING…"
                            else -> "REFRESH"
                        },
                        fontFamily = Hifi.mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.1.sp,
                        color = if (!canRefresh) Hifi.ink3 else Hifi.ink,
                    )
                }
                }
            }
            Text(
                text = "daemon connection" + (updatedLabel?.let { " · $it" } ?: ""),
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                letterSpacing = 0.2.sp,
                color = Hifi.ink3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (showError && rendezvousDetail != null) Notice(rendezvousDetail, error = true)
            if (showTimedOut) Notice("No recent-session response yet. The daemon may still be starting.", error = false)
            if (showUnsupported) Notice("This daemon does not support host dashboard session discovery.", error = false)
        }

        if (newSessionOpen) {
            NewSessionPanel(
                rtc = rtc,
                catalog = rtcState.newSessionDestinationsCatalog,
                loadingDestinations = rtcState.newSessionDestinationsCatalog == null,
                onClose = { newSessionOpen = false },
                onCreated = onNewSessionCreated,
                compact = compact,
            )
        }

        // Sessions list
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "RECENT OPENCLAW SESSIONS",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.4.sp,
                color = Hifi.ink2,
            )
            if (rtcState.recentSessions.isNotEmpty()) {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(
                        rtcState.recentSessions,
                        key = { "${it.session.sessionKey}:${it.session.sessionId}" },
                    ) { row ->
                        SessionButton(row = row, compact = compact, onSelect = onSelectSession)
                    }
                }
            } else {
                DashboardEmptyState(
                    loading = waiting || supportStatus == RecentSessionsSupportStatus.PROBING,
                    connected = rtcState.status == RtcStatus.OPEN,
                    unsupported = showUnsupported,
                )
            }
        }
    }
}

private const val NEW_SESSION_CREATE_TIMEOUT_MS = 15_000L

@Composable
private fun NewSessionPanel(
    rtc: RtcSession,
    catalog: NewSessionDestinationsCatalog?,
    loadingDestinations: Boolean,
    onClose: () -> Unit,
    onCreated: (RecentSession) -> Unit,
    compact: Boolean,
) {
    var providerId by remember { mutableStateOf<String?>(null) }
    var createRequestId by remember { mutableStateOf<String?>(null) }
    var createError by remember { mutableStateOf<String?>(null) }
    val effectiveCatalog = catalog ?: webOnlyNewSessionDestinationsCatalog()
    val providers = selectableNewSessionProviders(effectiveCatalog)
    val activeProvider = providerId?.let { id -> providers.firstOrNull { it.id == id } }
    val creating = createRequestId != null

    fun startCreate(provider: NewSessionDestinationProvider, destination: NewSessionDestinationOption? = null) {
        if (creating) return
        val requestId = UUID.randomUUID().toString()
        createRequestId = requestId
        createError = null
        rtc.sendControl(
            PhoneToDaemon.sessionsCreateRequest(
                NewSessionCreateInput(
                    requestId = requestId,
                    providerId = provider.id,
                    target = destination?.target,
                    accountId = destination?.accountId,
                ),
            ),
        )
    }

    DisposableEffect(rtc, createRequestId) {
        val off = rtc.addControlListener { msg ->
            val currentRequestId = createRequestId ?: return@addControlListener
            when (msg.t) {
                "sessions.created" -> {
                    if (msg.string("requestId") != currentRequestId) return@addControlListener
                    val session = msg.obj("session")?.let { decodeRecentSession(it) } ?: return@addControlListener
                    createRequestId = null
                    createError = null
                    onCreated(session)
                }
                "sessions.create.error" -> {
                    if (msg.string("requestId") != currentRequestId) return@addControlListener
                    createRequestId = null
                    createError = newSessionCreateErrorCopy(msg.string("message"))
                }
            }
        }
        onDispose { off() }
    }

    LaunchedEffect(createRequestId) {
        val requestId = createRequestId ?: return@LaunchedEffect
        delay(NEW_SESSION_CREATE_TIMEOUT_MS)
        if (createRequestId == requestId) {
            createRequestId = null
            createError = newSessionCreateErrorCopy("new_session_timeout")
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Hifi.ai.a(0x44), RoundedCornerShape(16.dp))
            .background(Color.White.copy(alpha = 0.045f), RoundedCornerShape(16.dp))
            .padding(if (compact) 10.dp else 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = activeProvider?.let { "NEW SESSION · ${it.label.uppercase()}" } ?: "NEW SESSION · CHOOSE CHAT",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                color = Hifi.ink2,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (activeProvider != null) {
                    SmallDashboardAction("BACK", enabled = !creating) {
                        providerId = null
                    }
                }
                SmallDashboardAction("CANCEL", enabled = !creating, onClick = onClose)
            }
        }

        createError?.let { Notice(it, error = true) }
        if (creating) {
            DashboardDashedText("Creating session…")
            return@Column
        }

        if (activeProvider == null) {
            for (provider in providers) {
                NewSessionProviderRow(provider = provider, compact = compact) {
                    if (provider.kind == "local") startCreate(provider) else providerId = provider.id
                }
            }
            if (loadingDestinations) {
                DashboardDashedText("Loading chat destinations in the background…")
            }
        } else {
            if (activeProvider.destinations.isEmpty()) {
                DashboardDashedText("No writable destinations reported by the daemon.")
            } else {
                for (destination in activeProvider.destinations) {
                    NewSessionDestinationRow(destination = destination, compact = compact) {
                        startCreate(activeProvider, destination)
                    }
                }
            }
        }
    }
}

@Composable
private fun SmallDashboardAction(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .border(1.dp, Hifi.stroke, RoundedCornerShape(10.dp))
            .let { if (enabled) it.clickable { onClick() } else it.alpha(0.55f) }
            .padding(horizontal = 9.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.1.sp,
            color = if (enabled) Hifi.ink2 else Hifi.ink3,
        )
    }
}

@Composable
private fun NewSessionProviderRow(
    provider: NewSessionDestinationProvider,
    compact: Boolean,
    onClick: () -> Unit,
) {
    val description = if (provider.kind == "local") {
        "Voice-only OpenClaw session. Replies stay in the app."
    } else {
        "${provider.destinations.size} channel${if (provider.destinations.size == 1) "" else "s"}"
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp))
            .background(Color.White.copy(alpha = 0.045f), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(if (compact) 10.dp else 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(provider.label, fontSize = if (compact) 14.sp else 15.sp, fontWeight = FontWeight.Bold, color = Hifi.ink)
        Text(description, fontSize = if (compact) 11.sp else 12.sp, lineHeight = 15.sp, color = Hifi.ink3)
    }
}

@Composable
private fun NewSessionDestinationRow(
    destination: NewSessionDestinationOption,
    compact: Boolean,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp))
            .background(Color.White.copy(alpha = 0.045f), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(if (compact) 10.dp else 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            destination.label,
            fontSize = if (compact) 14.sp else 15.sp,
            fontWeight = FontWeight.Bold,
            color = Hifi.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val meta = listOfNotNull(destination.group, destination.target).joinToString(" · ")
        Text(meta, fontFamily = Hifi.mono, fontSize = 10.sp, fontWeight = FontWeight.Bold, color = Hifi.ink3)
    }
}

@Composable
private fun DashboardDashedText(message: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    color = Hifi.stroke,
                    cornerRadius = CornerRadius(14.dp.toPx(), 14.dp.toPx()),
                    style = Stroke(
                        width = 1.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 8f)),
                    ),
                )
            }
            .padding(12.dp),
    ) {
        Text(message, color = Hifi.ink3, fontSize = 12.sp, lineHeight = 16.sp, fontFamily = Hifi.sans)
    }
}

private fun selectableNewSessionProviders(catalog: NewSessionDestinationsCatalog): List<NewSessionDestinationProvider> =
    catalog.providers.filter { provider ->
        provider.status == "available" && (provider.kind == "local" || provider.destinations.isNotEmpty())
    }

private fun newSessionCreateErrorCopy(code: String?): String = when (code) {
    "new_session_destination_unsupported" -> "The daemon cannot create sessions for that destination."
    "invalid_new_session_request", "invalid_new_session_target", "invalid_new_session_agent", "invalid_new_session_account" ->
        "The daemon rejected the new-session request."
    "discord_thread_create_failed" -> "The daemon could not create the Discord thread."
    "discord_thread_id_unresolved" -> "Discord did not return a usable thread id."
    "slack_thread_create_failed" -> "The daemon could not start the Slack thread."
    "slack_thread_ts_unresolved" -> "Slack did not return a usable thread timestamp."
    "new_session_timeout" -> "No response from the daemon. Try again."
    null, "" -> "Session creation failed."
    else -> "Session creation failed: $code"
}

@Composable
private fun ConnectionStatusPill(status: RtcStatus, label: String) {
    val color = when (status) {
        RtcStatus.OPEN -> Hifi.ai
        RtcStatus.ERROR, RtcStatus.CLOSED -> Hifi.accents.getValue("red").rec
        else -> Hifi.think
    }
    Row(
        modifier = Modifier
            .border(1.dp, color.a(0x55), RoundedCornerShape(999.dp))
            .background(color.a(0x12), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(7.dp).background(color, CircleShape))
        Text(
            label,
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.1.sp,
            color = color,
        )
    }
}

@Composable
private fun SessionButton(
    row: RecentSessionFavoriteState,
    compact: Boolean,
    onSelect: (RecentSession) -> Unit,
) {
    val session = row.session
    val favorite = row.favorite
    val preview = formatSessionPreview(session)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, if (favorite) Hifi.ai.a(0x88) else Hifi.stroke, RoundedCornerShape(14.dp))
            .background(
                if (favorite) Hifi.ai.a(0x10) else Color.White.copy(alpha = 0.045f),
                RoundedCornerShape(14.dp),
            )
            .clickable { onSelect(session) }
            .padding(
                start = if (compact) 12.dp else 14.dp,
                end = if (compact) 8.dp else 10.dp,
                top = if (compact) 8.dp else 10.dp,
                bottom = if (compact) 8.dp else 10.dp,
            ),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = session.displayLabel,
            fontSize = if (compact) 14.sp else 15.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = Hifi.sans,
            color = Hifi.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val metaStyle: @Composable (String) -> Unit = { value ->
                Text(
                    value,
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.5.sp,
                    color = Hifi.ink3,
                )
            }
            metaStyle(session.agent.ifEmpty { "unknown" })
            session.channel?.let { metaStyle(it) }
            session.lastActivity?.let { metaStyle(formatRelativeActivity(it)) }
            if (row.persistedFavorite) metaStyle("SAVED")
        }
        if (preview != null) {
            Row {
                Text(
                    text = preview.label + ":",
                    fontSize = if (compact) 11.sp else 12.sp,
                    lineHeight = if (compact) 15.sp else 16.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = Hifi.sans,
                    color = if (preview.assistantTone) Hifi.ai else Hifi.ink3,
                )
                Text(
                    text = " " + preview.text,
                    fontSize = if (compact) 11.sp else 12.sp,
                    lineHeight = if (compact) 15.sp else 16.sp,
                    fontFamily = Hifi.sans,
                    color = Hifi.ink2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private class SessionPreview(val label: String, val text: String, val assistantTone: Boolean)

private fun formatSessionPreview(session: RecentSession): SessionPreview? {
    val assistantPreview = session.lastAssistantPreview?.trim()
    if (!assistantPreview.isNullOrEmpty()) return SessionPreview("Agent", assistantPreview, true)
    val latestPreview = session.lastMessagePreview?.trim()
    if (latestPreview.isNullOrEmpty()) return null
    val role = session.lastMessageRole?.trim()?.lowercase()
    val label = if (role != null && role != "assistant" && role.isNotEmpty()) "Latest $role" else "Latest"
    return SessionPreview(label, latestPreview, false)
}

@Composable
private fun Notice(message: String, error: Boolean) {
    val color = if (error) Hifi.accents.getValue("red").rec else Hifi.think
    Text(
        text = message,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        lineHeight = 15.sp,
        color = color,
        fontFamily = Hifi.sans,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, color.a(0x55), RoundedCornerShape(10.dp))
            .background(color.a(0x12), RoundedCornerShape(10.dp))
            .padding(horizontal = 9.dp, vertical = 7.dp),
    )
}

@Composable
private fun DashboardEmptyState(loading: Boolean, connected: Boolean, unsupported: Boolean) {
    val message = when {
        unsupported -> "Session discovery is unavailable for this daemon."
        loading -> "Loading recent sessions…"
        connected -> "No recent sessions yet. Start or resume an OpenClaw conversation, then refresh."
        else -> "Connecting to the daemon before loading sessions…"
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    color = Hifi.stroke,
                    cornerRadius = CornerRadius(14.dp.toPx(), 14.dp.toPx()),
                    style = Stroke(
                        width = 1.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 8f)),
                    ),
                )
            }
            .padding(16.dp),
    ) {
        Text(
            text = message,
            color = Hifi.ink3,
            fontSize = 13.sp,
            lineHeight = 18.sp,
            fontFamily = Hifi.sans,
        )
    }
}

private fun formatConnectionLabel(status: RtcStatus, detail: String?): String = when (status) {
    RtcStatus.OPEN -> "CONNECTED"
    RtcStatus.CONNECTING -> "CONNECTING"
    RtcStatus.ERROR -> "ERROR"
    RtcStatus.CLOSED -> if (detail != null) "CLOSED" else "DISCONNECTED"
    else -> "WAITING"
}

private fun formatDaemonRendezvousDetail(detail: String?): String? {
    if (detail == null || detail == "session_replaced") return null
    if (detail == "unsupported_daemon_protocol") {
        return "Daemon protocol/capability mismatch. Update the installed daemon."
    }
    return "Daemon rendezvous error: $detail"
}

private fun formatUpdatedAt(generatedAt: String?, now: Long = System.currentTimeMillis()): String? {
    if (generatedAt.isNullOrEmpty()) return null
    val updatedAt = app.clawkietalkie.storage.parseIsoTimestamp(generatedAt)?.time ?: return null
    val elapsedMinutes = ((now - updatedAt).coerceAtLeast(0)) / 60_000
    if (elapsedMinutes < 1) return "updated just now"
    if (elapsedMinutes < 60) return "updated ${elapsedMinutes}m ago"
    val elapsedHours = elapsedMinutes / 60
    if (elapsedHours < 24) return "updated ${elapsedHours}h ago"
    val formatter = SimpleDateFormat("MMM d", Locale.getDefault())
    return "updated " + formatter.format(Date(updatedAt))
}

fun formatRelativeActivity(value: String, now: Long = System.currentTimeMillis()): String {
    val ts = app.clawkietalkie.storage.parseIsoTimestamp(value)?.time ?: return value
    val elapsedMinutes = ((now - ts).coerceAtLeast(0)) / 60_000
    if (elapsedMinutes < 1) return "just now"
    if (elapsedMinutes < 60) return "${elapsedMinutes}m ago"
    val elapsedHours = elapsedMinutes / 60
    if (elapsedHours < 24) return "${elapsedHours}h ago"
    return "${elapsedHours / 24}d ago"
}
