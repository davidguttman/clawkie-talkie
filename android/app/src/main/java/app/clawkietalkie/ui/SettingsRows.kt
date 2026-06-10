package app.clawkietalkie.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Settings building blocks. Mirror of the row components in the web
// client's Settings.tsx (section card, toggle switch with amber glow,
// dropdowns, segmented control, status row, technical row).

private val AMBER = Color(0xFFFF9E3B)

@Composable
fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Column(modifier = Modifier.padding(bottom = 22.dp)) {
        Text(
            title,
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            letterSpacing = 1.6.sp,
            color = Hifi.ink2,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 10.dp, start = 2.dp),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(Hifi.surface, RoundedCornerShape(14.dp))
                .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp)),
        ) {
            content()
        }
    }
}

@Composable
fun RowDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(Hifi.stroke),
    )
}

@Composable
fun ToggleRow(
    label: String,
    sub: String? = null,
    value: Boolean,
    setValue: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 13.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, fontSize = 13.sp, color = Hifi.ink, fontFamily = Hifi.sans)
            if (sub != null) {
                Text(
                    sub,
                    fontSize = 11.sp,
                    lineHeight = (11 * 1.4).sp,
                    color = Hifi.ink3,
                    fontFamily = Hifi.sans,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        // 40×24 track, 20px knob travelling 2 → 18, amber glow when on.
        val trackColor by animateColorAsState(
            targetValue = if (value) AMBER else Hifi.surface2,
            animationSpec = tween(200),
            label = "toggleTrack",
        )
        val knobOffset by animateDpAsState(
            targetValue = if (value) 18.dp else 2.dp,
            animationSpec = tween(200),
            label = "toggleKnob",
        )
        val glowAlpha by animateFloatAsState(
            targetValue = if (value) 0.4f else 0f,
            animationSpec = tween(200),
            label = "toggleGlow",
        )
        Box(
            modifier = Modifier
                .size(width = 40.dp, height = 24.dp)
                .drawBehind {
                    if (glowAlpha > 0f) {
                        drawRoundRect(
                            color = AMBER.copy(alpha = glowAlpha * 0.6f),
                            topLeft = Offset(-4.dp.toPx(), -4.dp.toPx()),
                            size = androidx.compose.ui.geometry.Size(
                                size.width + 8.dp.toPx(),
                                size.height + 8.dp.toPx(),
                            ),
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(
                                16.dp.toPx(),
                                16.dp.toPx(),
                            ),
                            alpha = 0.5f,
                        )
                    }
                }
                .background(trackColor, RoundedCornerShape(12.dp))
                .clickable { setValue(!value) },
        ) {
            Box(
                modifier = Modifier
                    .offset(x = knobOffset, y = 2.dp)
                    .size(20.dp)
                    .background(if (value) Color.Black else Hifi.ink3, CircleShape),
            )
        }
    }
    RowDivider()
}

@Composable
fun SelectRow(
    label: String,
    value: String,
    setValue: (String) -> Unit,
    options: List<SelectOption>,
    disabled: Boolean = false,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.find { it.id == value }?.label
        ?: options.firstOrNull()?.label
        ?: ""
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 13.dp)) {
        Text(
            label,
            fontSize = 13.sp,
            color = Hifi.ink,
            fontFamily = Hifi.sans,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        Box {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(if (disabled) Hifi.surface2 else Hifi.surface, RoundedCornerShape(9.dp))
                    .border(1.dp, Hifi.stroke, RoundedCornerShape(9.dp))
                    .let { if (!disabled) it.clickable { expanded = true } else it }
                    .padding(horizontal = 10.dp, vertical = 9.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    selectedLabel,
                    fontSize = 13.sp,
                    fontFamily = Hifi.sans,
                    color = if (disabled) Hifi.ink3 else Hifi.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text("▾", fontSize = 13.sp, color = Hifi.ink3)
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                containerColor = Hifi.surface2,
            ) {
                for (option in options) {
                    DropdownMenuItem(
                        text = {
                            Text(
                                option.label,
                                fontSize = 13.sp,
                                fontFamily = Hifi.sans,
                                color = if (option.disabled) Hifi.ink4 else Hifi.ink,
                            )
                        },
                        enabled = !option.disabled,
                        onClick = {
                            expanded = false
                            setValue(option.id)
                        },
                    )
                }
            }
        }
    }
    RowDivider()
}

@Composable
fun SegmentedRow(
    label: String,
    value: String,
    setValue: (String) -> Unit,
    options: List<SelectOption>,
    compact: Boolean,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 13.dp)) {
        Text(
            label,
            fontSize = 13.sp,
            color = Hifi.ink,
            fontFamily = Hifi.sans,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        if (compact) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (option in options) {
                    SegmentedOptionButton(option, value == option.id, compact = true) {
                        setValue(option.id)
                    }
                }
            }
        } else {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Hifi.surface2, RoundedCornerShape(10.dp))
                    .border(1.dp, Hifi.stroke, RoundedCornerShape(10.dp))
                    .padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (option in options) {
                    Box(modifier = Modifier.weight(1f)) {
                        SegmentedOptionButton(option, value == option.id, compact = false) {
                            setValue(option.id)
                        }
                    }
                }
            }
        }
    }
    RowDivider()
}

@Composable
private fun SegmentedOptionButton(
    option: SelectOption,
    on: Boolean,
    compact: Boolean,
    onClick: () -> Unit,
) {
    val background = if (on) Hifi.ink else if (compact) Hifi.surface2 else Color.Transparent
    val shape = RoundedCornerShape(if (compact) 9.dp else 7.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(background, shape)
            .let {
                if (compact) it.border(1.dp, if (on) Hifi.ink else Hifi.stroke, shape) else it
            }
            .clickable { onClick() }
            .padding(
                horizontal = if (compact) 12.dp else 6.dp,
                vertical = if (compact) 10.dp else 7.dp,
            ),
        contentAlignment = if (compact) Alignment.CenterStart else Alignment.Center,
    ) {
        Text(
            option.label.uppercase(),
            fontFamily = Hifi.mono,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            color = if (on) Color.Black else Hifi.ink2,
        )
    }
}

@Composable
fun ButtonRow(
    label: String,
    sub: String? = null,
    buttonLabel: String,
    onClick: () -> Unit,
    disabled: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 13.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, fontSize = 13.sp, color = Hifi.ink, fontFamily = Hifi.sans)
            if (sub != null) {
                Text(
                    sub,
                    fontSize = 11.sp,
                    lineHeight = (11 * 1.4).sp,
                    color = Hifi.ink3,
                    fontFamily = Hifi.sans,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        Box(
            modifier = Modifier
                .widthIn(min = 76.dp)
                .height(44.dp)
                .background(if (disabled) Hifi.surface2 else Hifi.ink, RoundedCornerShape(12.dp))
                .border(1.dp, Hifi.stroke, RoundedCornerShape(12.dp))
                .let { if (!disabled) it.clickable { onClick() } else it },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                buttonLabel.uppercase(),
                fontFamily = Hifi.mono,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
                color = if (disabled) Hifi.ink3 else Color.Black,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
    }
    RowDivider()
}

@Composable
fun StatusRow(text: String, onRefresh: (() -> Unit)? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text.uppercase(),
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            letterSpacing = 1.sp,
            color = Hifi.ink3,
            modifier = Modifier.weight(1f),
        )
        if (onRefresh != null) {
            Text(
                "REFRESH",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
                color = Hifi.ink2,
                modifier = Modifier
                    .background(Hifi.surface2, RoundedCornerShape(8.dp))
                    .border(1.dp, Hifi.stroke, RoundedCornerShape(8.dp))
                    .clickable { onRefresh() }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
    }
    RowDivider()
}

@Composable
fun TechnicalActionRow(
    label: String,
    value: String,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                label.uppercase(),
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                letterSpacing = 1.sp,
                color = Hifi.ink3,
            )
            Text(
                value,
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                letterSpacing = 0.2.sp,
                color = Hifi.ink4,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            actionLabel.uppercase(),
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            color = Hifi.ink2,
            modifier = Modifier
                .background(Hifi.surface2, RoundedCornerShape(8.dp))
                .border(1.dp, Hifi.stroke, RoundedCornerShape(8.dp))
                .clickable { onAction() }
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
    RowDivider()
}

@Composable
fun TechnicalRow(label: String, value: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            letterSpacing = 1.sp,
            color = Hifi.ink3,
        )
        Text(
            value,
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            letterSpacing = 0.2.sp,
            color = Hifi.ink4,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    RowDivider()
}

@Composable
fun SongsSubCategory(
    trackLabels: List<Pair<String, String>>,
    disabledTrackIds: List<String>,
    onToggle: (String, Boolean) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val noneEnabled = trackLabels.all { (id, _) -> disabledTrackIds.contains(id) }
    val arrowRotation by animateFloatAsState(
        targetValue = if (open) 180f else 0f,
        animationSpec = tween(200),
        label = "songsArrow",
    )

    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { open = !open }
                .padding(horizontal = 14.dp, vertical = 13.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Songs", fontSize = 13.sp, color = Hifi.ink, fontFamily = Hifi.sans)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (!open && noneEnabled) {
                    Text(
                        "NONE",
                        fontFamily = Hifi.mono,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp,
                        color = Hifi.ink3,
                    )
                }
                Text(
                    "▼",
                    fontSize = 16.sp,
                    color = Hifi.ink3,
                    modifier = Modifier.rotate(arrowRotation),
                )
            }
        }
        RowDivider()
        if (open) {
            for ((id, label) in trackLabels) {
                ToggleRow(
                    label = label,
                    value = !disabledTrackIds.contains(id),
                    setValue = { enabled -> onToggle(id, enabled) },
                )
            }
        }
    }
}
