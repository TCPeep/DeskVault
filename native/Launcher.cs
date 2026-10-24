// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Vault.exe - double-click launcher. Starts the Vault server hidden (if it isn't running yet)
// and opens it in the default browser. "--background" starts the server without a browser
// (used by the "Start with Windows" shortcut). Built by lib/native.js.

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        bool background = args.Length > 0 && args[0] == "--background";
        string bin = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string app = Path.GetDirectoryName(bin);
        string dataDir = Path.Combine(app, "data");
        int port = 4477;
        string node = "node.exe";
        try
        {
            string cfg = Path.Combine(dataDir, "launch.txt"); // written by the server: "<port>\n<node.exe path>"
            if (File.Exists(cfg))
            {
                string[] lines = File.ReadAllLines(cfg);
                if (lines.Length > 0) int.TryParse(lines[0].Trim(), out port);
                if (lines.Length > 1 && File.Exists(lines[1].Trim())) node = lines[1].Trim();
            }
        }
        catch { }
        // Copies of Vault on a backup drive carry their own node.exe (fresh Windows has no Node.js).
        string bundled = Path.Combine(app, "node", "node.exe");
        if (node == "node.exe" && File.Exists(bundled)) node = bundled;

        string url = "http://127.0.0.1:" + port + "/";
        if (!Alive(url))
        {
            try
            {
                var psi = new ProcessStartInfo(node, "\"" + Path.Combine(app, "server.js") + "\"");
                psi.WorkingDirectory = app;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch (Exception e)
            {
                if (!background)
                    MessageBox.Show("Couldn't start the Vault server:\n" + e.Message + "\n\nIs Node.js installed?", "Vault",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            for (int i = 0; i < 60 && !Alive(url); i++) Thread.Sleep(250);
        }
        if (!background)
        {
            if (!Alive(url))
            {
                MessageBox.Show("The Vault server didn't start. Check data\\vault.log for details.", "Vault",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
            Process.Start(url);
        }
        return 0;
    }

    static bool Alive(string url)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url + "api/ping");
            req.Timeout = 800;
            using (var res = (HttpWebResponse)req.GetResponse())
                return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }
}
