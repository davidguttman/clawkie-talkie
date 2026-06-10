package app.clawkietalkie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.protocol.SttCatalog
import app.clawkietalkie.protocol.SttSelection
import app.clawkietalkie.protocol.TtsCatalog
import app.clawkietalkie.protocol.TtsSelection
import app.clawkietalkie.storage.ExportFormat
import app.clawkietalkie.storage.MusicSettings
import app.clawkietalkie.storage.MusicVolumeLevel
import app.clawkietalkie.storage.Settings
import app.clawkietalkie.voice.HoldMusic
import app.clawkietalkie.voice.HoldMusicCatalog
import app.clawkietalkie.voice.HoldMusicController

// Settings screen. Mirror of the web client's Settings.tsx. TTS provider
// credentials are NOT stored on the phone — OpenClaw owns provider auth;
// this screen only edits on-device voice / export / music preferences.

@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    settings: Settings,
    setSettings: (Settings) -> Unit,
    hostPeerId: String?,
    ttsCatalog: TtsCatalog?,
    onRefreshTtsCatalog: () -> Unit,
    sttCatalog: SttCatalog?,
    onRefreshSttCatalog: () -> Unit,
    compact: Boolean,
    onChangeHost: (() -> Unit)? = null,
) {
    LaunchedEffect(ttsCatalog == null) {
        if (ttsCatalog == null) onRefreshTtsCatalog()
    }
    LaunchedEffect(sttCatalog == null) {
        if (sttCatalog == null) onRefreshSttCatalog()
    }

    fun updateTtsSelection(selection: TtsSelection) {
        setSettings(settings.copy(voice = selection.voice ?: "", tts = selection))
    }

    fun updateSttSelection(selection: SttSelection) {
        setSettings(settings.copy(stt = selection))
    }

    val musicSettings = settings.music
    val musicTracks = HoldMusicCatalog.TRACKS
    val disabledMusicTrackIds = musicSettings.disabledTracks
    val enabledMusicTrackCount = musicTracks.count { it !in disabledMusicTrackIds }
    var musicPreviewPlaying by remember { mutableStateOf(false) }
    val musicPreviewController = remember { mutableStateOf<HoldMusicController?>(null) }

    fun updateMusicSettings(music: MusicSettings) {
        HoldMusic.setSettings(music)
        setSettings(settings.copy(music = music))
    }

    fun stopMusicPreview() {
        musicPreviewController.value?.stop()
        musicPreviewController.value = null
        musicPreviewPlaying = false
    }

    fun toggleMusicPreview() {
        if (musicPreviewPlaying) {
            stopMusicPreview()
            return
        }
        if (enabledMusicTrackCount == 0) return
        val controller = HoldMusicController()
        musicPreviewController.value = controller
        controller.start()
        musicPreviewPlaying = true
    }

    // External mute changes (e.g. the PTT mute toggle) reflect back into the
    // settings object.
    DisposableEffect(Unit) {
        val unsubscribe = HoldMusic.subscribeMuted { muted ->
            if (settings.music.muted != muted) {
                setSettings(settings.copy(music = settings.music.copy(muted = muted)))
            }
        }
        onDispose {
            unsubscribe()
            musicPreviewController.value?.stop()
            musicPreviewController.value = null
        }
    }
    LaunchedEffect(enabledMusicTrackCount, musicPreviewPlaying) {
        if (musicPreviewPlaying && enabledMusicTrackCount == 0) stopMusicPreview()
    }

    // -- TTS provider/voice derivations (mirror of the web logic) --------
    val providerOptions = configuredTtsProviders(ttsCatalog)
    val currentProvider = providerForSelection(providerOptions, settings.tts)
    val ttsProviderValue = ttsProviderValueForSelection(providerOptions, settings.tts)
    val effectiveSelection = if (currentProvider != null) {
        TtsSelection(
            providerId = currentProvider.id,
            model = preferredModel(currentProvider, settings.tts),
            voice = preferredVoice(currentProvider, settings.tts),
        )
    } else settings.tts
    val voiceOptions = voicesForSelection(ttsCatalog, effectiveSelection)
    val selectedVoice = if (voiceOptions.any { it.id == effectiveSelection.voice }) {
        effectiveSelection.voice ?: ""
    } else voiceOptions.firstOrNull()?.id ?: ""
    val statusText = ttsCatalogStatusText(ttsCatalog, currentProvider, isDefaultTtsSelection(settings.tts))

    val sttProviderOptions = configuredSttProviders(sttCatalog)
    val currentSttProvider = sttProviderForSelection(sttProviderOptions, settings.stt)
    val sttProviderValue = sttProviderValueForSelection(sttProviderOptions, settings.stt)
    val effectiveSttSelection = if (currentSttProvider != null) {
        SttSelection(
            providerId = currentSttProvider.id,
            model = preferredSttModel(currentSttProvider, settings.stt),
        )
    } else settings.stt
    val sttStatusText = sttCatalogStatusText(sttCatalog, currentSttProvider, isDefaultSttSelection(settings.stt))

    Column(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
        ScreenHeader(title = "Settings", onBack = onBack)
        ScrollBody(pad = if (compact) 2.dp else 22.dp) {
            SettingsSection(title = "TRANSCRIPTION") {
                SelectRow(
                    label = "Provider",
                    value = sttProviderValue,
                    setValue = { providerId ->
                        if (providerId == DEFAULT_PROVIDER_OPTION_ID) {
                            updateSttSelection(SttSelection())
                        } else {
                            sttProviderOptions.find { it.id == providerId }
                                ?.takeIf { it.selectable }
                                ?.let { updateSttSelection(nextSttSelectionAfterProviderChange(it, settings.stt)) }
                        }
                    },
                    options = buildList {
                        add(SelectOption(DEFAULT_PROVIDER_OPTION_ID, "Default"))
                        addAll(
                            staleProviderOption(
                                settings.stt.providerId,
                                settings.stt.model != null,
                                currentSttProvider,
                                sttProviderOptions,
                            ) { it.id },
                        )
                        if (sttProviderOptions.isNotEmpty()) {
                            addAll(sttProviderOptions.map { SelectOption(it.id, it.label, disabled = !it.selectable) })
                        } else {
                            add(SelectOption("", "Loading from daemon...", disabled = true))
                        }
                    },
                )
                if (currentSttProvider != null && currentSttProvider.models.size > 1) {
                    SelectRow(
                        label = "Model",
                        value = effectiveSttSelection.model ?: currentSttProvider.models.firstOrNull() ?: "",
                        setValue = { model ->
                            if (currentSttProvider.selectable) {
                                updateSttSelection(effectiveSttSelection.copy(model = model))
                            }
                        },
                        options = currentSttProvider.models.map { SelectOption(it, it) },
                        disabled = !currentSttProvider.selectable,
                    )
                }
                StatusRow(text = sttStatusText, onRefresh = onRefreshSttCatalog)
            }

            SettingsSection(title = "VOICE") {
                SelectRow(
                    label = "Provider",
                    value = ttsProviderValue,
                    setValue = { providerId ->
                        if (providerId == DEFAULT_PROVIDER_OPTION_ID) {
                            updateTtsSelection(TtsSelection())
                        } else {
                            providerOptions.find { it.id == providerId }
                                ?.takeIf { it.selectable }
                                ?.let { updateTtsSelection(nextTtsSelectionAfterProviderChange(it, settings.tts)) }
                        }
                    },
                    options = buildList {
                        add(SelectOption(DEFAULT_PROVIDER_OPTION_ID, "Default"))
                        addAll(
                            staleProviderOption(
                                settings.tts.providerId,
                                settings.tts.model != null || settings.tts.voice != null,
                                currentProvider,
                                providerOptions,
                            ) { it.id },
                        )
                        if (providerOptions.isNotEmpty()) {
                            addAll(
                                providerOptions.map {
                                    SelectOption(it.id, providerSelectLabel(it), disabled = !it.selectable)
                                },
                            )
                        } else {
                            add(SelectOption("", "Loading from daemon...", disabled = true))
                        }
                    },
                )
                if (currentProvider != null && currentProvider.models.size > 1) {
                    SelectRow(
                        label = "Model",
                        value = effectiveSelection.model ?: currentProvider.models.firstOrNull() ?: "",
                        setValue = { model ->
                            if (currentProvider.selectable) {
                                updateTtsSelection(
                                    TtsSelection(
                                        providerId = currentProvider.id,
                                        model = model,
                                        voice = preferredVoice(currentProvider, settings.tts),
                                    ),
                                )
                            }
                        },
                        options = currentProvider.models.map { SelectOption(it, it) },
                        disabled = !currentProvider.selectable,
                    )
                }
                if (currentProvider != null) {
                    SelectRow(
                        label = "Voice",
                        value = selectedVoice,
                        setValue = { voiceId ->
                            if (currentProvider.selectable) {
                                voiceOptions.find { it.id == voiceId }
                                    ?.takeIf { !it.disabled }
                                    ?.let { updateTtsSelection(effectiveSelection.copy(voice = it.id)) }
                            }
                        },
                        options = voiceOptions.ifEmpty {
                            listOf(TtsVoiceOption("", "No voices available", disabled = true))
                        }.map { SelectOption(it.id, it.label, it.disabled) },
                        disabled = !currentProvider.selectable || voiceOptions.all { it.disabled },
                    )
                } else {
                    SelectRow(
                        label = "Voice",
                        value = "",
                        setValue = {},
                        options = listOf(
                            SelectOption(
                                "",
                                if (isDefaultTtsSelection(settings.tts)) "Select a provider to choose a voice"
                                else "Saved provider unavailable",
                                disabled = true,
                            ),
                        ),
                        disabled = true,
                    )
                }
                StatusRow(text = statusText, onRefresh = onRefreshTtsCatalog)
            }

            SettingsSection(title = "EXPORT") {
                SegmentedRow(
                    label = "Format",
                    value = settings.format.id,
                    setValue = { id ->
                        val format = when (id) {
                            "txt" -> ExportFormat.TXT
                            "json" -> ExportFormat.JSON
                            else -> ExportFormat.MD
                        }
                        setSettings(settings.copy(format = format))
                    },
                    options = listOf(
                        SelectOption("md", "Markdown"),
                        SelectOption("txt", "Text"),
                        SelectOption("json", "JSON"),
                    ),
                    compact = compact,
                )
                ToggleRow(
                    label = "Include timestamps",
                    value = settings.timestamps,
                    setValue = { setSettings(settings.copy(timestamps = it)) },
                )
            }

            SettingsSection(title = "MUSIC") {
                ToggleRow(
                    label = "Hold music",
                    sub = "Play hold music while waiting for a response",
                    value = !musicSettings.muted,
                    setValue = { enabled -> updateMusicSettings(musicSettings.copy(muted = !enabled)) },
                )
                ToggleRow(
                    label = "Audio effects",
                    sub = "Add hiss, crackle, and distortion for that true “on hold” feel",
                    value = musicSettings.effects,
                    setValue = { effects -> updateMusicSettings(musicSettings.copy(effects = effects)) },
                )
                SegmentedRow(
                    label = "Hold music level",
                    value = musicSettings.volumeLevel.id,
                    setValue = { id ->
                        val level = when (id) {
                            "low" -> MusicVolumeLevel.LOW
                            "high" -> MusicVolumeLevel.HIGH
                            else -> MusicVolumeLevel.MEDIUM
                        }
                        updateMusicSettings(musicSettings.copy(volumeLevel = level))
                    },
                    options = listOf(
                        SelectOption("low", "Low"),
                        SelectOption("medium", "Medium"),
                        SelectOption("high", "High"),
                    ),
                    compact = compact,
                )
                ButtonRow(
                    label = "Hold music test",
                    sub = "Preview the current hold music settings",
                    buttonLabel = if (musicPreviewPlaying) "Stop" else "Start",
                    onClick = ::toggleMusicPreview,
                    disabled = enabledMusicTrackCount == 0,
                )
                if (musicTracks.isNotEmpty()) {
                    SongsSubCategory(
                        trackLabels = musicTracks.map { it to HoldMusicCatalog.trackLabel(it) },
                        disabledTrackIds = disabledMusicTrackIds,
                        onToggle = { trackId, enabled ->
                            val disabledTracks = if (enabled) {
                                musicSettings.disabledTracks.filter { it != trackId }
                            } else {
                                musicSettings.disabledTracks.filter { it != trackId } + trackId
                            }
                            updateMusicSettings(musicSettings.copy(disabledTracks = disabledTracks))
                        },
                    )
                } else {
                    StatusRow(text = "No hold music tracks available")
                }
            }

            SettingsSection(title = "TECHNICAL") {
                val hostValue = hostPeerId?.trim().takeUnless { it.isNullOrEmpty() } ?: "Unavailable"
                if (onChangeHost != null) {
                    TechnicalActionRow(
                        label = "Host ID",
                        value = hostValue,
                        actionLabel = "Change",
                        onAction = onChangeHost,
                    )
                } else {
                    TechnicalRow(label = "Host ID", value = hostValue)
                }
            }
        }

        // Footer bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .drawBehind {
                    drawLine(
                        color = Hifi.stroke,
                        start = androidx.compose.ui.geometry.Offset(0f, 0f),
                        end = androidx.compose.ui.geometry.Offset(size.width, 0f),
                        strokeWidth = 1.dp.toPx(),
                    )
                }
                .background(Hifi.surface)
                .padding(horizontal = 4.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "CLAWKIE-TALKIE",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                letterSpacing = 1.2.sp,
                color = Hifi.ink2,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                "PHASE 0",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                letterSpacing = 1.2.sp,
                color = Hifi.ink3,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}
