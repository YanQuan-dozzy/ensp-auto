' ensp-auto 无窗口启动 shim
' 由 start.cmd（或 start.exe）以 wscript 调起，本身不产生任何窗口。
' 只做一件事：把 start.ps1 以完全隐藏的窗口跑起来。
'
' 参数 1 ：项目根目录（即 start.ps1 所在目录）

Option Explicit

Dim sh, fso, root, ps1, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = ""
If WScript.Arguments.Count > 0 Then root = WScript.Arguments(0)

If root = "" Then
  ' 没传就取本脚本所在目录，要求 .vbs 与 start.ps1 同级
  root = fso.GetParentFolderName(WScript.ScriptFullName)
End If

ps1 = fso.BuildPath(root, "start.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "找不到 " & ps1, 16, "ensp-auto"
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
      & """" & ps1 & """"

' 0 = 完全隐藏窗口，False = 不等待
sh.Run cmd, 0, False
WScript.Quit 0
