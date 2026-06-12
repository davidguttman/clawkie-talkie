package app.clawkietalkie.ui

import app.clawkietalkie.protocol.NewSessionDestinationOption
import app.clawkietalkie.protocol.NewSessionDestinationProvider
import app.clawkietalkie.protocol.NewSessionDestinationsCatalog
import java.util.Locale

internal const val NEW_SESSION_NO_WRITABLE_DESTINATIONS = "No writable destinations reported by the daemon."
internal const val NEW_SESSION_NO_DESTINATION_SEARCH_MATCHES = "No destinations match your search."

internal data class NewSessionDestinationGroup(
    val group: String?,
    val destinations: List<NewSessionDestinationOption>,
)

internal fun selectableNewSessionProviders(catalog: NewSessionDestinationsCatalog): List<NewSessionDestinationProvider> =
    catalog.providers.filter { provider ->
        provider.status == "available" && (provider.kind == "local" || provider.destinations.isNotEmpty())
    }

internal fun filterNewSessionDestinations(
    destinations: List<NewSessionDestinationOption>,
    query: String,
): List<NewSessionDestinationOption> {
    val normalized = query.trim().lowercase(Locale.ROOT)
    if (normalized.isEmpty()) return destinations
    return destinations.filter { destination ->
        destination.label.containsNewSessionQuery(normalized) ||
            destination.target.containsNewSessionQuery(normalized) ||
            destination.group.orEmpty().containsNewSessionQuery(normalized)
    }
}

internal fun groupNewSessionDestinations(
    destinations: List<NewSessionDestinationOption>,
): List<NewSessionDestinationGroup> {
    val groups = mutableListOf<MutableNewSessionDestinationGroup>()
    val byGroup = linkedMapOf<String, MutableNewSessionDestinationGroup>()
    for (destination in destinations) {
        val key = destination.group ?: ""
        val group = byGroup.getOrPut(key) {
            MutableNewSessionDestinationGroup(destination.group).also { groups.add(it) }
        }
        group.destinations.add(destination)
    }
    return groups.map { NewSessionDestinationGroup(it.group, it.destinations.toList()) }
}

internal fun newSessionDestinationsEmptyCopy(
    totalDestinationCount: Int,
    filteredDestinationCount: Int,
): String? = when {
    filteredDestinationCount > 0 -> null
    totalDestinationCount == 0 -> NEW_SESSION_NO_WRITABLE_DESTINATIONS
    else -> NEW_SESSION_NO_DESTINATION_SEARCH_MATCHES
}

private data class MutableNewSessionDestinationGroup(
    val group: String?,
    val destinations: MutableList<NewSessionDestinationOption> = mutableListOf(),
)

private fun String.containsNewSessionQuery(normalizedQuery: String): Boolean =
    lowercase(Locale.ROOT).contains(normalizedQuery)
