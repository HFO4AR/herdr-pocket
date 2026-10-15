plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.herdr.pocket"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.herdr.pocket"
        minSdk = 26
        targetSdk = 35
        testInstrumentationRunner = "dev.herdr.pocket.SecureProfilesTest"
        versionCode = System.getenv("POCKET_VERSION_CODE")?.toInt() ?: 4
        versionName = System.getenv("POCKET_VERSION_NAME") ?: "0.4.0"
    }
    signingConfigs {
        if (System.getenv("POCKET_KEYSTORE") != null) create("distribution") {
            storeFile = file(System.getenv("POCKET_KEYSTORE"))
            storePassword = System.getenv("POCKET_STORE_PASSWORD")
            keyAlias = "pocket"
            keyPassword = System.getenv("POCKET_STORE_PASSWORD")
        }
    }
    buildTypes {
        getByName("release") {
            if (System.getenv("POCKET_KEYSTORE") != null) signingConfig = signingConfigs.getByName("distribution")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "META-INF/versions/**/OSGI-INF/MANIFEST.MF" }
    sourceSets["main"].assets.srcDir("../bridge")
    androidResources { ignoreAssetsPattern = ".*:__pycache__:*.pyc" }
}
dependencies {
    implementation("com.github.mwiede:jsch:2.27.5")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
}
