plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "app.clawkietalkie"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.clawkietalkie"
        minSdk = 26
        targetSdk = 35
        versionCode = 1000006
        versionName = "1.0.5"

        // Transport defaults mirror the web client's Vite env fallbacks
        // (VITE_SIGNAL_SERVER / VITE_ICE_SERVERS_JSON / VITE_DEFAULT_HOST_ID).
        buildConfigField("String", "SIGNAL_SERVER", "\"${project.findProperty("ct.signalServer") ?: "https://api.rambly.app"}\"")
        buildConfigField("String", "ICE_SERVERS_JSON", "\"${project.findProperty("ct.iceServersJson") ?: ""}\"")
        buildConfigField("String", "DEFAULT_HOST_ID", "\"${project.findProperty("ct.defaultHostId") ?: ""}\"")
        buildConfigField("String", "WEB_ORIGIN", "\"${project.findProperty("ct.webOrigin") ?: "https://clawkietalkie.app"}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    sourceSets {
        getByName("test") {
            resources.srcDir(project.file("../../shared/contract"))
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.16.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("io.getstream:stream-webrtc-android:1.3.8")

    implementation("androidx.media3:media3-exoplayer:1.6.1")
    implementation("androidx.media3:media3-datasource:1.6.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
}
