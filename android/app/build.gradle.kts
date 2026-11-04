plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional: sign every build with the same key, so new versions install as
// updates (keeping their permissions) instead of needing an uninstall.
// The CI workflow sets these from GitHub secrets; see README.
val keystorePath: String? = System.getenv("HUB_KEYSTORE_PATH")

android {
    namespace = "uk.school.classroomhub"
    compileSdk = 34

    defaultConfig {
        applicationId = "uk.school.classroomhub"
        // Fire OS 5 = API 22, Fire OS 7 = API 28, Fire OS 8 = API 30.
        minSdk = 22
        // Matches Fire OS 8 (Android 11). Raising this changes background,
        // notification and accessibility rules - test on a tablet first.
        targetSdk = 30
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("hub") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("HUB_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("HUB_KEY_ALIAS")
                keyPassword = System.getenv("HUB_KEY_PASSWORD")
                // Fire OS 8 requires v2 signatures; v1 keeps older tablets happy.
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            if (keystorePath != null) signingConfig = signingConfigs.getByName("hub")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
}
