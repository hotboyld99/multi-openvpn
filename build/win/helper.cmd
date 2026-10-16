@echo off
rem Started by the "MultiOpenVPN Helper" SYSTEM task: runs the app binary as Node with the helper script.
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\Multi OpenVPN.exe" "%~dp0app.asar\out\main\helper.js" %*
