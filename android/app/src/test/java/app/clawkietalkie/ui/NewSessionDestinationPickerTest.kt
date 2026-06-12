package app.clawkietalkie.ui

import app.clawkietalkie.protocol.NewSessionDestinationOption
import app.clawkietalkie.protocol.NewSessionDestinationProvider
import app.clawkietalkie.protocol.NewSessionDestinationsCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NewSessionDestinationPickerTest {
    private val design = destination("1", "discord:design", "Design Review", "Discord")
    private val qa = destination("2", "slack:qa", "Release QA", "Slack")
    private val ungrouped = destination("3", "matrix:ops", "Ops Room", null)

    @Test
    fun filtersDestinationsByLabelTargetAndGroupCaseInsensitive() {
        val destinations = listOf(design, qa, ungrouped)

        assertEquals(listOf(design), filterNewSessionDestinations(destinations, "design"))
        assertEquals(listOf(qa), filterNewSessionDestinations(destinations, "SLACK:QA"))
        assertEquals(listOf(design), filterNewSessionDestinations(destinations, " discord "))
        assertEquals(destinations, filterNewSessionDestinations(destinations, "   "))
    }

    @Test
    fun groupsDestinationsByGroupPreservingFirstSeenOrder() {
        val anotherDiscord = destination("4", "discord:mobile", "Mobile", "Discord")

        val groups = groupNewSessionDestinations(listOf(design, qa, anotherDiscord, ungrouped))

        assertEquals(3, groups.size)
        assertEquals("Discord", groups[0].group)
        assertEquals(listOf(design, anotherDiscord), groups[0].destinations)
        assertEquals("Slack", groups[1].group)
        assertEquals(listOf(qa), groups[1].destinations)
        assertNull(groups[2].group)
        assertEquals(listOf(ungrouped), groups[2].destinations)
    }

    @Test
    fun emptyCopyDistinguishesEmptyProviderFromNoSearchMatches() {
        assertEquals(NEW_SESSION_NO_WRITABLE_DESTINATIONS, newSessionDestinationsEmptyCopy(0, 0))
        assertEquals(NEW_SESSION_NO_DESTINATION_SEARCH_MATCHES, newSessionDestinationsEmptyCopy(3, 0))
        assertNull(newSessionDestinationsEmptyCopy(3, 1))
    }

    @Test
    fun selectableProvidersMatchWebCreatableChoices() {
        val local = provider("local", "local", "available", emptyList())
        val channel = provider("discord", "channel", "available", listOf(design))
        val emptyChannel = provider("slack", "channel", "available", emptyList())
        val unavailable = provider("teams", "channel", "error", listOf(qa))
        val catalog = NewSessionDestinationsCatalog(
            generatedAt = "",
            providers = listOf(local, channel, emptyChannel, unavailable),
        )

        assertEquals(listOf(local, channel), selectableNewSessionProviders(catalog))
    }

    private fun destination(
        id: String,
        target: String,
        label: String,
        group: String?,
    ) = NewSessionDestinationOption(
        id = id,
        target = target,
        label = label,
        group = group,
    )

    private fun provider(
        id: String,
        kind: String,
        status: String,
        destinations: List<NewSessionDestinationOption>,
    ) = NewSessionDestinationProvider(
        id = id,
        label = id,
        kind = kind,
        status = status,
        destinations = destinations,
    )
}
