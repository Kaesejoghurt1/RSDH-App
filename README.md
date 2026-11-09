# RSDoktorhut Fernsteuerung

Installierbare, deutschsprachige PWA zur Steuerung des RSDoktorhut-Neblers über Bluetooth LE. Die App verwendet Web Bluetooth und den Nordic UART Service (NUS); sie benötigt daher Chrome oder Samsung Internet auf Android und eine HTTPS-Adresse.

## Verwendung

1. Öffne nach der Pages-Aktivierung die Adresse: <https://kaesejoghurt1.github.io/RSDH-App/>.
2. Drücke den Knopf am Gerät, um das Verbindungsfenster zu öffnen.
3. Wähle **Gerät verbinden** und anschließend **RSDoktorhut**.
4. Installiere die PWA über das Browser-Menü, falls gewünscht.

Die App verbindet sich nur im Vordergrund erneut. Außerhalb des Verbindungsfensters ist das BLE-Radio des Geräts ausgeschaltet.

## Veröffentlichung und Updates

Die App ist buildless und benötigt keine Abhängigkeiten. Die Quelldateien liegen im Ordner `app/` des lokalen AtomizerDH-Projekts. Das Firmware-Projekt ist derzeit nicht unter einer öffentlichen GitHub-URL erreichbar.

Zum Veröffentlichen oder Aktualisieren:

1. Klone `git@github.com:Kaesejoghurt1/RSDH-App.git` und wechsle in das Repository.
2. Kopiere den **Inhalt** von `AtomizerDH/app/` in das Wurzelverzeichnis dieses Repositories. Die vorhandene `.git`-Verwaltung bleibt unberührt.
3. Prüfe die Änderungen, committe sie auf `main` und pushe nach `origin`.

GitHub Pages muss im Repository einmalig unter **Settings → Pages** für den Branch `main` und das Verzeichnis `/(root)` aktiviert werden. Die resultierende HTTPS-Adresse ist die obige Pages-Adresse.

## Projektbezug

Die PWA ist Teil des lokalen Projekts **AtomizerDH** und steuert dessen Firmware über die NUS-Durchreiche. Eine öffentliche URL zum Firmware-Repository ist derzeit nicht eingerichtet.
