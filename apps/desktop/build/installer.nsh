!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; MUI uses the same page-text defines for installation and uninstallation.
!ifdef BUILD_UNINSTALLER
  !define MUI_WELCOMEPAGE_TITLE "Uninstall ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove Pact and its shortcuts.$\r$\n$\r$\nYour projects, conversation data and agent configuration will be kept."
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} was removed"
  !define MUI_FINISHPAGE_TEXT "Pact and its shortcuts have been removed.$\r$\n$\r$\nYour projects, conversation data and agent configuration have been kept.$\r$\n$\r$\nClick Finish to close Setup."
!else
  !define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "A local workspace where Claude Code and Codex collaborate.$\r$\n$\r$\nPlan, build and review together. Your conversation history is stored locally on your computer.$\r$\n$\r$\nChoose where to install Pact and how you open it. Your existing projects and agent settings are kept."
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} is installed"
  !define MUI_FINISHPAGE_TEXT "You're ready to open Pact.$\r$\n$\r$\nConnect your existing Claude Code and Codex tools, then choose your default session settings.$\r$\n$\r$\nClick Finish to close Setup."
  !define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCT_NAME}"
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
!endif

!ifndef BUILD_UNINSTALLER
  Var PactDesktopShortcut
  Var PactDesktopCheckbox

  ; Extend electron-builder's own shortcut policy instead of creating a second shortcut owner.
  !undef isNoDesktopShortcut
  !define isNoDesktopShortcut `"" PactNoDesktopShortcut ""`
  !macro _PactNoDesktopShortcut _a _b _t _f
    StrCmp $PactDesktopShortcut "0" `${_t}` 0
    !insertmacro _isNoDesktopShortcut `${_a}` `${_b}` `${_t}` `${_f}`
  !macroend

  !macro customInit
    ${If} ${isForAllUsers}
      MessageBox MB_OK|MB_ICONSTOP "Pact installs for the current Windows account. Restart Setup without /allusers."
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} $hasPerMachineInstallation == "1"
      MessageBox MB_OK|MB_ICONSTOP "An all-users installation already exists. Remove it before installing Pact for this account. Your project and conversation data will be kept."
      SetErrorLevel 2
      Quit
    ${EndIf}
    !insertmacro setInstallModePerUser
    StrCpy $hasPerMachineInstallation "0"
    StrCpy $hasPerUserInstallation "1"
    StrCpy $PactDesktopShortcut "1"
  !macroend

  !macro customWelcomePage
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !macro customPageAfterChangeDir
    Page custom PactOptionsShow PactOptionsLeave

    ; Define functions here: electron-builder registers NSIS plugins after this include.
    Function PactOptionsShow
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Make Pact easy to find" "Choose how you open your workspace."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0u 12u 300u 14u "Create a desktop shortcut"
    Pop $PactDesktopCheckbox
    ${NSD_SetState} $PactDesktopCheckbox $PactDesktopShortcut
    ${NSD_CreateLabel} 12u 34u 288u 28u "Pact is always available from the Start menu."
    Pop $0
    ${NSD_CreateLabel} 0u 94u 300u 28u "Installed for your Windows account. Your existing projects and agent settings are kept."
    Pop $0
    nsDialogs::Show
    FunctionEnd

    Function PactOptionsLeave
      ${NSD_GetState} $PactDesktopCheckbox $PactDesktopShortcut
    FunctionEnd
  !macroend
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customHeader
  !if "${APP_ID}" == "com.pact.desktop.installer-preview"
    BrandingText "Pact ${VERSION} | Installer preview"
  !endif
!macroend

; An install/upgrade never terminates an active Pact task on the user's behalf.
!macro customCheckAppRunning
  pact_wait_for_exit:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
    ${If} $0 == 0
      ${If} ${Silent}
        SetErrorLevel 2
        Quit
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "Pact is running. Finish any active tasks and close Pact before continuing." IDRETRY pact_wait_for_exit
      SetErrorLevel 2
      Quit
    ${EndIf}
!macroend
