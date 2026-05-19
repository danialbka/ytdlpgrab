import AppKit
import Foundation
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let qualityDefaultsKey = "SelectedQuality"
    private let modeDefaultsKey = "SelectedDownloadMode"
    private let qualityOptions = [
        QualityOption(id: "best", title: "Best Available"),
        QualityOption(id: "2160", title: "4K / 2160p"),
        QualityOption(id: "1440", title: "1440p"),
        QualityOption(id: "1080", title: "1080p"),
        QualityOption(id: "720", title: "720p"),
        QualityOption(id: "480", title: "480p"),
        QualityOption(id: "360", title: "360p")
    ]
    private let modeOptions = [
        DownloadModeOption(id: "youtube", title: "YouTube Video"),
        DownloadModeOption(id: "audio", title: "Audio")
    ]
    private var serverProcess: Process?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var healthTimer: Timer?
    private var isHealthy = false
    private var healthSummary = "Checking..."
    private var toolSummary = ""
    private var lastError: String?

    private var helperURL: URL {
        URL(string: "http://127.0.0.1:17427/health")!
    }

    private var resourcesURL: URL {
        Bundle.main.resourceURL ?? Bundle.main.bundleURL
    }

    private var serverScriptURL: URL {
        resourcesURL.appendingPathComponent("server/index.js")
    }

    private var bundledBinURL: URL {
        resourcesURL.appendingPathComponent("bin", isDirectory: true)
    }

    private var logsDirectoryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/ytdlpgrab", isDirectory: true)
    }

    private var desktopURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Desktop", isDirectory: true)
    }

    private var selectedQualityId: String {
        get {
            let stored = UserDefaults.standard.string(forKey: qualityDefaultsKey) ?? "best"
            return qualityOptions.contains { $0.id == stored } ? stored : "best"
        }
        set {
            UserDefaults.standard.set(newValue, forKey: qualityDefaultsKey)
        }
    }

    private var selectedQualityTitle: String {
        qualityOptions.first { $0.id == selectedQualityId }?.title ?? "Best Available"
    }

    private var selectedModeId: String {
        get {
            let stored = UserDefaults.standard.string(forKey: modeDefaultsKey) ?? "youtube"
            return modeOptions.contains { $0.id == stored } ? stored : "youtube"
        }
        set {
            UserDefaults.standard.set(newValue, forKey: modeDefaultsKey)
        }
    }

    private var selectedModeTitle: String {
        modeOptions.first { $0.id == selectedModeId }?.title ?? "YouTube Video"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        appendDiagnostic("applicationDidFinishLaunching")
        NSApp.setActivationPolicy(.accessory)
        statusItem.button?.title = "YT"
        statusItem.button?.toolTip = "YTDLPGrab"
        rebuildMenu()
        startServer()
        refreshHealth()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshHealth()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    @objc private func startServer() {
        appendDiagnostic("startServer requested")
        guard serverProcess == nil else {
            refreshHealth()
            return
        }

        guard FileManager.default.fileExists(atPath: serverScriptURL.path) else {
            lastError = "Missing bundled server script."
            appendDiagnostic("missing server script at \(serverScriptURL.path)")
            isHealthy = false
            rebuildMenu()
            return
        }

        guard let scriptRunner = resolveJavaScriptExecutable() else {
            lastError = "JavaScript runtime was not found."
            appendDiagnostic("JavaScript runtime missing")
            isHealthy = false
            rebuildMenu()
            return
        }

        do {
            try FileManager.default.createDirectory(
                at: logsDirectoryURL,
                withIntermediateDirectories: true
            )
            let outputURL = logsDirectoryURL.appendingPathComponent("helper.log")
            let errorURL = logsDirectoryURL.appendingPathComponent("helper.error.log")
            ensureFileExists(outputURL)
            ensureFileExists(errorURL)

            outputHandle = try FileHandle(forWritingTo: outputURL)
            errorHandle = try FileHandle(forWritingTo: errorURL)
            outputHandle?.seekToEndOfFile()
            errorHandle?.seekToEndOfFile()

            let process = Process()
            process.executableURL = URL(fileURLWithPath: scriptRunner)
            process.arguments = [serverScriptURL.path]
            process.currentDirectoryURL = resourcesURL
            process.environment = [
                "PATH": "\(bundledBinURL.path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "PYTHONPATH": resourcesURL.appendingPathComponent("python").path,
                "YTDLPGRAB_HOST": "127.0.0.1",
                "YTDLPGRAB_PORT": "17427",
                "YTDLPGRAB_QUALITY": selectedQualityId,
                "YTDLPGRAB_MODE": selectedModeId
            ]
            process.standardOutput = outputHandle
            process.standardError = errorHandle
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if self.serverProcess === process {
                        self.serverProcess = nil
                        self.closeLogHandles()
                        self.lastError = process.terminationStatus == 0
                            ? nil
                            : "Helper exited with code \(process.terminationStatus)."
                        self.refreshHealth()
                    }
                }
            }

            try process.run()
            appendDiagnostic("server process launched using \(scriptRunner)")
            serverProcess = process
            lastError = nil
            healthSummary = "Starting..."
            rebuildMenu()
        } catch {
            lastError = error.localizedDescription
            appendDiagnostic("failed to launch server: \(error.localizedDescription)")
            closeLogHandles()
            rebuildMenu()
        }
    }

    @objc private func stopServer() {
        serverProcess?.terminate()
        serverProcess = nil
        closeLogHandles()
        refreshHealth()
    }

    @objc private func toggleStartAtLogin() {
        guard #available(macOS 13.0, *) else {
            lastError = "Start at Login needs macOS 13 or newer."
            rebuildMenu()
            return
        }

        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }

        rebuildMenu()
    }

    @objc private func selectQuality(_ sender: NSMenuItem) {
        guard
            let qualityId = sender.representedObject as? String,
            qualityOptions.contains(where: { $0.id == qualityId })
        else {
            return
        }

        selectedQualityId = qualityId
        appendDiagnostic("quality changed to \(qualityId)")

        restartServerIfNeeded()
    }

    @objc private func selectMode(_ sender: NSMenuItem) {
        guard
            let modeId = sender.representedObject as? String,
            modeOptions.contains(where: { $0.id == modeId })
        else {
            return
        }

        selectedModeId = modeId
        appendDiagnostic("mode changed to \(modeId)")

        restartServerIfNeeded()
    }

    @objc private func openDesktop() {
        NSWorkspace.shared.open(desktopURL)
    }

    @objc private func openLogs() {
        do {
            try FileManager.default.createDirectory(
                at: logsDirectoryURL,
                withIntermediateDirectories: true
            )
        } catch {
            lastError = error.localizedDescription
        }
        NSWorkspace.shared.open(logsDirectoryURL)
    }

    @objc private func openExtensionFolder() {
        let extensionURL = resourcesURL.appendingPathComponent("extension", isDirectory: true)
        NSWorkspace.shared.open(extensionURL)
    }

    @objc private func quitApp() {
        stopServer()
        NSApp.terminate(nil)
    }

    private func refreshHealth() {
        var request = URLRequest(url: helperURL)
        request.timeoutInterval = 1.5

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }

                if let error {
                    self.isHealthy = false
                    self.healthSummary = self.serverProcess == nil ? "Stopped" : "Starting..."
                    self.toolSummary = ""
                    if self.serverProcess == nil {
                        self.lastError = nil
                    } else {
                        self.lastError = error.localizedDescription
                    }
                    self.rebuildMenu()
                    return
                }

                guard
                    let data,
                    let health = try? JSONDecoder().decode(Health.self, from: data),
                    health.ok
                else {
                    self.isHealthy = false
                    self.healthSummary = "Not ready"
                    self.toolSummary = ""
                    self.rebuildMenu()
                    return
                }

                self.isHealthy = true
                let saves = health.activeSaves ?? 0
                let jobs = health.activeJobs ?? 0
                if saves > 0 || jobs > 0 {
                    self.healthSummary = "Working..."
                } else {
                    self.healthSummary = "Ready"
                }
                self.toolSummary = [
                    health.tools?.ytDlp.available == true
                        ? "yt-dlp \(health.tools?.ytDlp.version ?? "")"
                        : "yt-dlp missing",
                    health.tools?.ffmpeg.available == true
                        ? "ffmpeg \(health.tools?.ffmpeg.version ?? "")"
                        : "ffmpeg missing"
                ].joined(separator: " | ")
                self.lastError = nil
                self.rebuildMenu()
            }
        }.resume()
    }

    private func rebuildMenu() {
        statusItem.button?.title = isHealthy ? "YT" : "YT!"

        let menu = NSMenu()

        let title = NSMenuItem(title: "YTDLPGrab", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        let status = NSMenuItem(title: "Server: \(healthSummary)", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        if !toolSummary.isEmpty {
            let tools = NSMenuItem(title: toolSummary, action: nil, keyEquivalent: "")
            tools.isEnabled = false
            menu.addItem(tools)
        }

        if let lastError {
            let errorItem = NSMenuItem(title: "Error: \(lastError)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)
        }

        menu.addItem(.separator())

        if serverProcess == nil {
            menu.addItem(withTitle: "Start Server", action: #selector(startServer), keyEquivalent: "")
        } else {
            menu.addItem(withTitle: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
        }

        let modeItem = NSMenuItem(title: "Mode: \(selectedModeTitle)", action: nil, keyEquivalent: "")
        let modeMenu = NSMenu()
        for option in modeOptions {
            let item = NSMenuItem(
                title: option.title,
                action: #selector(selectMode(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = option.id
            item.state = option.id == selectedModeId ? .on : .off
            modeMenu.addItem(item)
        }
        menu.addItem(modeItem)
        menu.setSubmenu(modeMenu, for: modeItem)

        let qualityItem = NSMenuItem(title: "Quality: \(selectedQualityTitle)", action: nil, keyEquivalent: "")
        let qualityMenu = NSMenu()
        for option in qualityOptions {
            let item = NSMenuItem(
                title: option.title,
                action: #selector(selectQuality(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = option.id
            item.state = option.id == selectedQualityId ? .on : .off
            qualityMenu.addItem(item)
        }
        menu.addItem(qualityItem)
        menu.setSubmenu(qualityMenu, for: qualityItem)

        menu.addItem(withTitle: "Open Desktop", action: #selector(openDesktop), keyEquivalent: "")
        menu.addItem(withTitle: "Open Logs", action: #selector(openLogs), keyEquivalent: "")
        menu.addItem(withTitle: "Open Extension Folder", action: #selector(openExtensionFolder), keyEquivalent: "")

        menu.addItem(.separator())

        let loginItem = NSMenuItem(
            title: "Start at Login",
            action: #selector(toggleStartAtLogin),
            keyEquivalent: ""
        )
        loginItem.state = startAtLoginState()
        menu.addItem(loginItem)

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit YTDLPGrab", action: #selector(quitApp), keyEquivalent: "q")

        statusItem.menu = menu
    }

    private func restartServerIfNeeded() {
        if serverProcess == nil {
            rebuildMenu()
            return
        }

        stopServer()
        healthSummary = "Restarting..."
        rebuildMenu()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.startServer()
        }
    }

    private func startAtLoginState() -> NSControl.StateValue {
        guard #available(macOS 13.0, *) else {
            return .off
        }
        return SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func resolveJavaScriptExecutable() -> String? {
        for candidate in [
            bundledBinURL.appendingPathComponent("bun").path,
            bundledBinURL.appendingPathComponent("node").path,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ] where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    private func ensureFileExists(_ url: URL) {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
    }

    private func closeLogHandles() {
        try? outputHandle?.close()
        try? errorHandle?.close()
        outputHandle = nil
        errorHandle = nil
    }

    private func appendDiagnostic(_ message: String) {
        do {
            try FileManager.default.createDirectory(
                at: logsDirectoryURL,
                withIntermediateDirectories: true
            )
            let line = "[app] \(Date()) \(message)\n"
            let url = logsDirectoryURL.appendingPathComponent("app.log")
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: url)
            handle.seekToEndOfFile()
            if let data = line.data(using: .utf8) {
                handle.write(data)
            }
            try handle.close()
        } catch {
            // Diagnostics must never make the menu app fail to launch.
        }
    }
}

private struct QualityOption {
    let id: String
    let title: String
}

private struct DownloadModeOption {
    let id: String
    let title: String
}

private struct Health: Decodable {
    let ok: Bool
    let activeJobs: Int?
    let activeSaves: Int?
    let tools: Tools?
}

private struct Tools: Decodable {
    let ytDlp: ToolStatus
    let ffmpeg: ToolStatus
}

private struct ToolStatus: Decodable {
    let available: Bool
    let version: String?
}
