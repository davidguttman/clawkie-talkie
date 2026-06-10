package app.clawkietalkie.ui

import app.clawkietalkie.protocol.SttCatalog
import app.clawkietalkie.protocol.SttSelection
import app.clawkietalkie.protocol.TtsCatalog
import app.clawkietalkie.protocol.TtsSelection

// Pure provider/voice option logic for the Settings screen. Mirror of the
// exported helpers in the web client's Settings.tsx.

const val DEFAULT_PROVIDER_OPTION_ID = "__default__"
const val STALE_PROVIDER_OPTION_ID = "__saved_provider__"

data class TtsVoiceOption(val id: String, val label: String, val disabled: Boolean = false)

data class TtsProviderOption(
    val id: String,
    val label: String,
    val configured: Boolean,
    val selected: Boolean,
    val available: Boolean,
    val selectable: Boolean,
    val models: List<String>,
    val voices: List<TtsVoiceOption>,
)

data class SttProviderOption(
    val id: String,
    val label: String,
    val configured: Boolean,
    val selected: Boolean,
    val available: Boolean,
    val selectable: Boolean,
    val models: List<String>,
)

data class SelectOption(val id: String, val label: String, val disabled: Boolean = false)

fun configuredTtsProviders(catalog: TtsCatalog?): List<TtsProviderOption> {
    if (catalog == null) return emptyList()
    return catalog.providers
        .map { provider ->
            TtsProviderOption(
                id = provider.id,
                label = provider.name.ifEmpty { provider.id },
                configured = provider.configured,
                selected = provider.selected || provider.id == catalog.activeProvider,
                available = provider.available,
                selectable = provider.configured && provider.available &&
                    (provider.models.isNotEmpty() || provider.voices.isNotEmpty()),
                models = provider.models,
                voices = provider.voices.map { TtsVoiceOption(it.id, it.name.ifEmpty { it.id }) },
            )
        }
        .sortedWith(
            compareBy<TtsProviderOption> { providerRank(it.selectable, it.configured, it.available) }
                .thenByDescending { it.selected }
                .thenBy { it.label },
        )
}

fun configuredSttProviders(catalog: SttCatalog?): List<SttProviderOption> {
    if (catalog == null) return emptyList()
    return catalog.providers
        .map { provider ->
            val selectable = provider.configured && provider.available && provider.models.isNotEmpty()
            val baseLabel = provider.name.ifEmpty { provider.id }
            val label = if (provider.configured && provider.available && provider.models.isEmpty()) {
                "$baseLabel (no model)"
            } else baseLabel
            SttProviderOption(
                id = provider.id,
                label = label,
                configured = provider.configured,
                selected = provider.selected || provider.id == catalog.activeProvider,
                available = provider.available,
                selectable = selectable,
                models = provider.models,
            )
        }
        .sortedWith(
            compareBy<SttProviderOption> { providerRank(it.selectable, it.configured, it.available) }
                .thenByDescending { it.selected }
                .thenBy { it.label },
        )
}

private fun providerRank(selectable: Boolean, configured: Boolean, available: Boolean): Int = when {
    selectable -> 0
    configured && available -> 1
    configured -> 2
    available -> 3
    else -> 4
}

fun providerForSelection(providers: List<TtsProviderOption>, selection: TtsSelection): TtsProviderOption? {
    val providerId = selection.providerId ?: return null
    return providers.find { it.id == providerId }
}

fun sttProviderForSelection(providers: List<SttProviderOption>, selection: SttSelection): SttProviderOption? {
    val providerId = selection.providerId ?: return null
    return providers.find { it.id == providerId }
}

fun preferredModel(provider: TtsProviderOption, selection: TtsSelection): String? {
    if (selection.model != null && provider.models.contains(selection.model)) return selection.model
    return provider.models.firstOrNull()
}

fun preferredVoice(provider: TtsProviderOption, selection: TtsSelection): String? {
    if (selection.voice != null && provider.voices.any { it.id == selection.voice }) return selection.voice
    return provider.voices.firstOrNull()?.id
}

fun preferredSttModel(provider: SttProviderOption, selection: SttSelection): String? {
    if (selection.model != null && provider.models.contains(selection.model)) return selection.model
    return provider.models.firstOrNull()
}

fun isDefaultTtsSelection(selection: TtsSelection): Boolean =
    selection.providerId == null && selection.model == null && selection.voice == null

fun isDefaultSttSelection(selection: SttSelection): Boolean =
    selection.providerId == null && selection.model == null

fun ttsProviderValueForSelection(providers: List<TtsProviderOption>, selection: TtsSelection): String =
    providerForSelection(providers, selection)?.id
        ?: selection.providerId
        ?: if (isDefaultTtsSelection(selection)) DEFAULT_PROVIDER_OPTION_ID else STALE_PROVIDER_OPTION_ID

fun sttProviderValueForSelection(providers: List<SttProviderOption>, selection: SttSelection): String =
    sttProviderForSelection(providers, selection)?.id
        ?: selection.providerId
        ?: if (isDefaultSttSelection(selection)) DEFAULT_PROVIDER_OPTION_ID else STALE_PROVIDER_OPTION_ID

fun nextTtsSelectionAfterProviderChange(
    provider: TtsProviderOption,
    current: TtsSelection,
): TtsSelection {
    if (!provider.selectable) return current
    return TtsSelection(
        providerId = provider.id,
        model = preferredModel(provider, current),
        voice = preferredVoice(provider, current),
    )
}

fun nextSttSelectionAfterProviderChange(
    provider: SttProviderOption,
    current: SttSelection,
): SttSelection {
    if (!provider.selectable) return current
    return SttSelection(providerId = provider.id, model = preferredSttModel(provider, current))
}

fun voicesForSelection(catalog: TtsCatalog?, selection: TtsSelection): List<TtsVoiceOption> {
    if (catalog == null) {
        return selection.voice?.let { listOf(TtsVoiceOption(it, it, disabled = true)) } ?: emptyList()
    }
    val providers = configuredTtsProviders(catalog)
    val provider = providerForSelection(providers, selection)
        ?: return selection.voice?.let { listOf(TtsVoiceOption(it, it, disabled = true)) } ?: emptyList()
    return provider.voices.map { it.copy(disabled = !provider.selectable || it.disabled) }
}

fun providerSelectLabel(provider: TtsProviderOption): String =
    if (provider.configured && provider.available && provider.models.isEmpty() && provider.voices.isEmpty()) {
        "${provider.label} (no voices)"
    } else provider.label

fun ttsCatalogStatusText(
    catalog: TtsCatalog?,
    provider: TtsProviderOption?,
    isDefaultSelection: Boolean,
): String {
    if (catalog == null) {
        return if (isDefaultSelection) "Loading voice providers from daemon"
        else "Connect to daemon to load voices"
    }
    if (isDefaultSelection) {
        return if (catalog.providers.isEmpty()) "No voice providers loaded"
        else "OpenClaw will choose voice defaults"
    }
    if (provider?.selectable != true) return "Provider unavailable"
    return "Loaded from daemon"
}

fun sttCatalogStatusText(
    catalog: SttCatalog?,
    provider: SttProviderOption?,
    isDefaultSelection: Boolean,
): String {
    if (catalog == null) {
        return if (isDefaultSelection) "Loading transcription providers from daemon"
        else "Connect to daemon to load transcription providers"
    }
    if (isDefaultSelection) {
        return if (catalog.providers.isEmpty()) "No transcription providers loaded"
        else "OpenClaw will choose transcription defaults"
    }
    if (provider != null && provider.models.isEmpty()) return "Transcription provider has no selectable models"
    if (provider?.selectable != true) return "Transcription provider unavailable"
    return "Loaded from daemon"
}

fun <T> staleProviderOption(
    providerId: String?,
    hasModelOrVoice: Boolean,
    currentProvider: T?,
    providerOptions: List<T>,
    idOf: (T) -> String,
): List<SelectOption> {
    if (providerId == null || currentProvider != null || providerOptions.any { idOf(it) == providerId }) {
        if (providerId == null && hasModelOrVoice) {
            return listOf(SelectOption(STALE_PROVIDER_OPTION_ID, "Saved selection (unavailable)", disabled = true))
        }
        return emptyList()
    }
    return listOf(SelectOption(providerId, "$providerId (unavailable)", disabled = true))
}
