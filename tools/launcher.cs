using System;
using System.Diagnostics;
using System.IO;

// ensp-auto 无窗口启动器（编译产物 = start.exe）
// 行为：读取 exe 所在目录（即项目根），静默调用 powershell 执行 start.ps1。
// 由 tools/make-launcher-cs.py 用 csc 编译（GUI 子系统，无控制台）。
class ENSPAutoLauncher
{
    static int Main()
    {
        try
        {
            string root = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
            if (string.IsNullOrEmpty(root)) root = AppDomain.CurrentDomain.BaseDirectory;
            string ps1 = Path.Combine(root, "start.ps1");
            if (!File.Exists(ps1)) return 1;

            string logDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ensp-auto");
            try { Directory.CreateDirectory(logDir); } catch { }

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + ps1 + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            string log = Path.Combine(logDir, "start.log");
            try
            {
                // start.ps1 会把控制台输出编码设为 UTF-8（BOM 文件 + [Console]::OutputEncoding），
                // 这里必须用 UTF-8 解码 stdout/stderr，否则中文日志会变乱码（GBK 误读 UTF-8）。
                psi.StandardOutputEncoding = System.Text.Encoding.UTF8;
                psi.StandardErrorEncoding = System.Text.Encoding.UTF8;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) Append(log, e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) Append(log, e.Data); };
                    p.Start();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    p.WaitForExit();
                    return p.ExitCode;
                }
            }
            catch
            {
                // 重定向失败则退化为直接启动
                Process.Start(psi);
                return 0;
            }
        }
        catch
        {
            return 2;
        }
    }

    static void Append(string path, string line)
    {
        try
        {
            File.AppendAllText(path, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + "\r\n");
        }
        catch { }
    }
}