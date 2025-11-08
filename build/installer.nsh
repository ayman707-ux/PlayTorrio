!macro customUnInstall
  ; Use product name so this tracks your package.json build.productName
  !define APPNAME "${PRODUCT_NAME}"

  ; Remove Electron userData (already handled by deleteAppDataOnUninstall, but keep as safety)
  RMDir /r "$APPDATA\${APPNAME}"

  ; Remove Local caches and updater remnants
  RMDir /r "$LOCALAPPDATA\${APPNAME}"
  RMDir /r "$LOCALAPPDATA\${APPNAME}-updater"

  ; Remove any Electron cache folders sometimes left under Local
  RMDir /r "$LOCALAPPDATA\${APPNAME}\Cache"
  RMDir /r "$LOCALAPPDATA\${APPNAME}\Code Cache"
  RMDir /r "$LOCALAPPDATA\${APPNAME}\GPUCache"

  ; Remove installer temp dir if present
  RMDir /r "$LOCALAPPDATA\Temp\${APPNAME}"

  ; Clean electron-builder cache entries for this app
  Delete "$LOCALAPPDATA\electron-builder\Cache\*${APPNAME}*.exe"
  Delete "$LOCALAPPDATA\electron-builder\Cache\*${APPNAME}*.yml"
  Delete "$LOCALAPPDATA\electron-builder\Cache\*${APPNAME}*.blockmap"
!macroend
