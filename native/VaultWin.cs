// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// VaultWin.exe - small Windows helper used by the Vault server.
// Built automatically by lib/native.js with the .NET Framework csc.exe (C# 5 syntax only).
//
//   resolve <volumeRoot> <hexFileId>...   find where files/folders live now, by NTFS file ID
//   pick <files|folder> <multi 0|1> [title] native Open dialog, prints chosen paths
//   recycle <path>...                     send to Recycle Bin (never a silent permanent delete)
//   drives                                list drives with type/label/space
//   open <path> | reveal <path>           open with default app / show in Explorer
//   shortcut <lnk> <target> <args> <workdir> <icon> <description>
//   apps                                  installed desktop programs + UserAssist launch history
//   appexists <tag> <key>                 is that Uninstall entry still there?
//   appicons <listFile> <size>            listFile lines: outPng<TAB>iconSpec; extracts icons to PNG
//   uninstall <commandLine>               run an uninstaller (its own UI, UAC as needed), wait for it
//
// Every command prints a single JSON value on stdout.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

static class VaultWin
{
    [STAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 0) { Console.Error.WriteLine("usage: VaultWin <command> ..."); return 2; }
        try
        {
            switch (args[0])
            {
                case "version": Out("\"3\""); return 0;
                case "resolve": return Resolve(args);
                case "pick": return Pick(args);
                case "recycle": return Recycle(args);
                case "drives": return Drives();
                case "open": return OpenDefault(args);
                case "reveal": return Reveal(args);
                case "shortcut": return Shortcut(args);
                case "hello-check": return HelloCheck();
                case "hello": return Hello(args);
                case "binsize": return BinSize();
                case "emptybin": return EmptyBin();
                case "apps": return AppsWin.List();
                case "appexists": return AppsWin.Exists(args);
                case "appicons": return AppsWin.Icons(args);
                case "uninstall": return AppsWin.Uninstall(args);
            }
            Console.Error.WriteLine("unknown command: " + args[0]);
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.GetType().Name + ": " + e.Message);
            return 1;
        }
    }

    // ---------- JSON output ----------
    internal static void Out(string json) { Console.Out.Write(json); Console.Out.Flush(); }

    internal static string J(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    static string StripLongPrefix(string p)
    {
        if (p == null) return null;
        if (p.StartsWith(@"\\?\UNC\")) return @"\\" + p.Substring(8);
        if (p.StartsWith(@"\\?\")) return p.Substring(4);
        return p;
    }

    // ---------- resolve by file ID ----------
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct FILE_ID_DESCRIPTOR
    {
        [FieldOffset(0)] public uint dwSize;
        [FieldOffset(4)] public int Type;
        [FieldOffset(8)] public long FileId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeFileHandle OpenFileById(SafeFileHandle volumeHint, ref FILE_ID_DESCRIPTOR id, uint access, uint share, IntPtr sa, uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint cch, uint flags);

    const uint FILE_SHARE_ALL = 7;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

    static int Resolve(string[] a)
    {
        if (a.Length < 2) throw new ArgumentException("resolve <volumeRoot> <id>...");
        var parts = new List<string>();
        using (var hint = CreateFileW(a[1], 0, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
        {
            int hintErr = hint.IsInvalid ? Marshal.GetLastWin32Error() : 0;
            for (int i = 2; i < a.Length; i++)
            {
                string id = a[i];
                string path = null; int err = hintErr;
                if (err == 0)
                {
                    long fileId;
                    if (!long.TryParse(id, System.Globalization.NumberStyles.HexNumber, null, out fileId)) err = 87;
                    else
                    {
                        var d = new FILE_ID_DESCRIPTOR();
                        d.dwSize = 24; d.Type = 0; d.FileId = fileId;
                        using (var h = OpenFileById(hint, ref d, 0, FILE_SHARE_ALL, IntPtr.Zero, FILE_FLAG_BACKUP_SEMANTICS))
                        {
                            if (h.IsInvalid) err = Marshal.GetLastWin32Error();
                            else
                            {
                                var sb = new StringBuilder(32768);
                                uint n = GetFinalPathNameByHandleW(h, sb, 32768, 0);
                                if (n == 0 || n >= 32768) err = Marshal.GetLastWin32Error();
                                else path = StripLongPrefix(sb.ToString());
                            }
                        }
                    }
                }
                parts.Add("{\"id\":" + J(id) + ",\"path\":" + J(path) + ",\"err\":" + err + "}");
            }
        }
        Out("[" + string.Join(",", parts.ToArray()) + "]");
        return 0;
    }

    // ---------- native pickers (IFileOpenDialog) ----------
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialogCoClass { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IShellItemArray ppenum);
        void GetSelectedItems(out IShellItemArray ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemArray
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
        void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
        void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
        void GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
        void GetCount(out uint pdwNumItems);
        void GetItemAt(uint dwIndex, out IShellItem ppsi);
        void EnumItems(out IntPtr ppenumShellItems);
    }

    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_ALLOWMULTISELECT = 0x200,
               FOS_PATHMUSTEXIST = 0x800, FOS_FILEMUSTEXIST = 0x1000;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);

    // An invisible, topmost 1x1 window on the monitor under the mouse. Dialogs owned by it
    // open in front of the browser instead of hiding behind it.
    static Form MakeOwner()
    {
        var owner = new Form();
        owner.FormBorderStyle = FormBorderStyle.None;
        // A taskbar button, so a dialog that ends up behind other windows is easy to find.
        owner.ShowInTaskbar = true;
        owner.Text = "Vault";
        try { owner.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        owner.TopMost = true;
        owner.StartPosition = FormStartPosition.Manual;
        Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
        owner.Bounds = new Rectangle(wa.X + wa.Width / 2, wa.Y + wa.Height / 3, 1, 1);
        owner.Opacity = 0;
        owner.Show();
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        SetForegroundWindow(owner.Handle);
        BringWindowToTop(owner.Handle);
        if (attached) AttachThreadInput(me, fgThread, false);
        return owner;
    }

    static int Pick(string[] a)
    {
        bool folders = a.Length > 1 && a[1] == "folder";
        bool multi = a.Length > 2 && a[2] == "1";
        string title = a.Length > 3 && a[3].Length > 0 ? a[3] : null;
        Application.EnableVisualStyles();
        Form owner = MakeOwner();
        var results = new List<string>();
        try
        {
            var dlg = (IFileOpenDialog)new FileOpenDialogCoClass();
            uint opts;
            dlg.GetOptions(out opts);
            opts |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
            if (folders) opts |= FOS_PICKFOLDERS; else opts |= FOS_FILEMUSTEXIST;
            if (multi) opts |= FOS_ALLOWMULTISELECT;
            dlg.SetOptions(opts);
            if (title != null) dlg.SetTitle(title);
            dlg.SetOkButtonLabel(folders ? "Add folder" : "Add");
            int hr = dlg.Show(owner.Handle);
            if (hr == 0)
            {
                IShellItemArray arr;
                dlg.GetResults(out arr);
                uint n;
                arr.GetCount(out n);
                for (uint i = 0; i < n; i++)
                {
                    IShellItem it;
                    arr.GetItemAt(i, out it);
                    string p;
                    it.GetDisplayName(SIGDN_FILESYSPATH, out p);
                    if (!string.IsNullOrEmpty(p)) results.Add(p);
                }
            }
        }
        finally { owner.Close(); }
        var parts = new List<string>();
        foreach (var p in results) parts.Add(J(p));
        Out("[" + string.Join(",", parts.ToArray()) + "]");
        return 0;
    }

    // ---------- Recycle Bin ----------
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
        [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
        public ushort fFlags;
        [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHFileOperationW(ref SHFILEOPSTRUCT op);

    const uint FO_DELETE = 3;
    const ushort FOF_SILENT = 0x4, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40,
                 FOF_NOERRORUI = 0x400, FOF_WANTNUKEWARNING = 0x4000;

    static int Recycle(string[] a)
    {
        var parts = new List<string>();
        Form owner = null;
        try
        {
            for (int i = 1; i < a.Length; i++)
            {
                string p = a[i];
                bool existed = File.Exists(p) || Directory.Exists(p);
                int code = 0; bool aborted = false;
                if (existed)
                {
                    if (owner == null) owner = MakeOwner();
                    var op = new SHFILEOPSTRUCT();
                    op.hwnd = owner.Handle;
                    op.wFunc = FO_DELETE;
                    op.pFrom = p + "\0";
                    // ALLOWUNDO = Recycle Bin. WANTNUKEWARNING makes Windows ask first if the item
                    // can't be recycled (too big, no bin on that drive) instead of destroying it.
                    op.fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING | FOF_SILENT | FOF_NOERRORUI);
                    code = SHFileOperationW(ref op);
                    aborted = op.fAnyOperationsAborted;
                }
                bool gone = !(File.Exists(p) || Directory.Exists(p));
                parts.Add("{\"path\":" + J(p) + ",\"existed\":" + (existed ? "true" : "false") + ",\"code\":" + code +
                          ",\"aborted\":" + (aborted ? "true" : "false") + ",\"gone\":" + (gone ? "true" : "false") + "}");
            }
        }
        finally { if (owner != null) owner.Close(); }
        Out("[" + string.Join(",", parts.ToArray()) + "]");
        return 0;
    }

    // ---------- drives ----------
    static int Drives()
    {
        var parts = new List<string>();
        foreach (var d in DriveInfo.GetDrives())
        {
            string type = d.DriveType.ToString();
            bool ready = false; string label = null, format = null; long total = 0, free = 0;
            // Network/optical drives can stall for seconds when offline; only query local media.
            if (d.DriveType == DriveType.Fixed || d.DriveType == DriveType.Removable)
            {
                try
                {
                    ready = d.IsReady;
                    if (ready) { label = d.VolumeLabel; format = d.DriveFormat; total = d.TotalSize; free = d.AvailableFreeSpace; }
                }
                catch { ready = false; }
            }
            parts.Add("{\"root\":" + J(d.Name) + ",\"type\":" + J(type) + ",\"ready\":" + (ready ? "true" : "false") +
                      ",\"label\":" + J(label) + ",\"format\":" + J(format) + ",\"total\":" + total + ",\"free\":" + free + "}");
        }
        Out("[" + string.Join(",", parts.ToArray()) + "]");
        return 0;
    }

    // ---------- open / reveal ----------
    static int OpenDefault(string[] a)
    {
        var psi = new ProcessStartInfo(a[1]);
        psi.UseShellExecute = true;
        // Local files start in their own folder; URLs and shell: locations have none.
        if (a[1].Length > 2 && a[1][1] == ':' && a[1][2] == '\\')
        {
            try
            {
                string dir = Path.GetDirectoryName(a[1]);
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) psi.WorkingDirectory = dir;
            }
            catch { }
        }
        Process.Start(psi);
        Out("true");
        return 0;
    }

    static int Reveal(string[] a)
    {
        // Paths can't contain '"', so quoting is safe here.
        var psi = new ProcessStartInfo("explorer.exe", "/select,\"" + a[1] + "\"");
        psi.UseShellExecute = false;
        Process.Start(psi);
        Out("true");
        return 0;
    }

    // ---------- Windows Hello (PIN / fingerprint / face) ----------
    // WinRT is reached through reflection so this still compiles with the plain .NET Framework csc.
    const string UCV = "Windows.Security.Credentials.UI.{0}, Windows.Security.Credentials.UI, ContentType=WindowsRuntime";

    [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    interface IUserConsentVerifierInterop
    {
        [return: MarshalAs(UnmanagedType.IInspectable)]
        object RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
    }

    static object AwaitWinRT(object op, Type resultType)
    {
        var asm = Assembly.Load("System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089");
        var ext = asm.GetType("System.WindowsRuntimeSystemExtensions");
        MethodInfo asTask = null;
        foreach (var mi in ext.GetMethods())
            if (mi.Name == "AsTask" && mi.IsGenericMethodDefinition && mi.GetParameters().Length == 1 &&
                mi.GetParameters()[0].ParameterType.Name == "IAsyncOperation`1") { asTask = mi; break; }
        var task = (System.Threading.Tasks.Task)asTask.MakeGenericMethod(resultType).Invoke(null, new object[] { op });
        while (!task.IsCompleted) { Application.DoEvents(); System.Threading.Thread.Sleep(30); }
        return task.GetType().GetProperty("Result").GetValue(task, null);
    }

    static int HelloCheck()
    {
        Type ucv = Type.GetType(string.Format(UCV, "UserConsentVerifier"), true);
        object op = ucv.GetMethod("CheckAvailabilityAsync").Invoke(null, null);
        Out(J(AwaitWinRT(op, Type.GetType(string.Format(UCV, "UserConsentVerifierAvailability"), true)).ToString()));
        return 0;
    }

    static int Hello(string[] a)
    {
        string message = a.Length > 1 && a[1].Length > 0 ? a[1] : "Unlock Vault";
        Type ucv = Type.GetType(string.Format(UCV, "UserConsentVerifier"), true);
        Type resultType = Type.GetType(string.Format(UCV, "UserConsentVerificationResult"), true);
        Form owner = MakeOwner();
        string result;
        try
        {
            object op;
            try
            {
                // Parenting the prompt to our window makes it open in front instead of behind the browser.
                var interop = (IUserConsentVerifierInterop)System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal.GetActivationFactory(ucv);
                Guid iid = new Guid("fd596ffd-2318-558f-9dbe-d21df43764a5"); // IAsyncOperation<UserConsentVerificationResult>
                op = interop.RequestVerificationForWindowAsync(owner.Handle, message, ref iid);
            }
            catch
            {
                op = ucv.GetMethod("RequestVerificationAsync").Invoke(null, new object[] { message });
            }
            result = AwaitWinRT(op, resultType).ToString();
        }
        finally { owner.Close(); }
        Out(J(result));
        return 0;
    }

    // ---------- Recycle Bin size / empty ----------
    [StructLayout(LayoutKind.Sequential)]
    struct SHQUERYRBINFO { public int cbSize; public long i64Size; public long i64NumItems; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHQueryRecycleBinW(string root, ref SHQUERYRBINFO info);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHEmptyRecycleBinW(IntPtr hwnd, string root, uint flags);

    static int BinSize()
    {
        var info = new SHQUERYRBINFO();
        info.cbSize = Marshal.SizeOf(typeof(SHQUERYRBINFO));
        int hr = SHQueryRecycleBinW(null, ref info);
        Out("{\"hr\":" + hr + ",\"bytes\":" + info.i64Size + ",\"items\":" + info.i64NumItems + "}");
        return 0;
    }

    static int EmptyBin()
    {
        // The app already asked for confirmation; keep Windows' progress window, skip its second prompt.
        Form owner = MakeOwner();
        int hr;
        try { hr = SHEmptyRecycleBinW(owner.Handle, null, 0x1 | 0x4); } finally { owner.Close(); }
        Out("{\"hr\":" + hr + "}");
        return 0;
    }

    // ---------- shortcuts ----------
    static int Shortcut(string[] a)
    {
        if (a.Length < 7) throw new ArgumentException("shortcut <lnk> <target> <args> <workdir> <icon> <description>");
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { a[1] });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { a[2] });
        lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { a[3] });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { a[4] });
        if (a[5].Length > 0) lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { a[5] + ",0" });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { a[6] });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        Out("true");
        return 0;
    }
}

// ---------- installed apps (Storage > Installed apps) ----------
static class AppsWin
{
    const string UNINSTALL = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    static string S(Microsoft.Win32.RegistryKey k, string name)
    {
        try { object v = k.GetValue(name); if (v == null) return null; string s = v.ToString().Trim(); return s.Length == 0 ? null : s; }
        catch { return null; }
    }
    static long N(Microsoft.Win32.RegistryKey k, string name)
    {
        try { object v = k.GetValue(name); return v == null ? 0 : Convert.ToInt64(v); } catch { return 0; }
    }
    static bool IsGuid(string s) { Guid g; return s.Length == 38 && s[0] == '{' && Guid.TryParse(s, out g); }

    static Microsoft.Win32.RegistryKey Root(string tag)
    {
        if (tag == "HKLM64") return Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64);
        if (tag == "HKLM32") return Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry32);
        if (tag == "HKCU") return Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.CurrentUser, Microsoft.Win32.RegistryView.Default);
        throw new ArgumentException("unknown hive " + tag);
    }

    public static int List()
    {
        var parts = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string tag in new[] { "HKLM64", "HKLM32", "HKCU" }) Scan(tag, parts, seen);
        var usage = UserAssist();
        VaultWin.Out("{\"apps\":[" + string.Join(",", parts.ToArray()) + "],\"usage\":[" + string.Join(",", usage.ToArray()) + "]}");
        return 0;
    }

    static void Scan(string tag, List<string> parts, HashSet<string> seen)
    {
        Microsoft.Win32.RegistryKey root = null, un = null;
        try
        {
            root = Root(tag);
            un = root.OpenSubKey(UNINSTALL);
            if (un == null) return;
            foreach (string key in un.GetSubKeyNames())
            {
                Microsoft.Win32.RegistryKey k = null;
                try
                {
                    k = un.OpenSubKey(key);
                    if (k == null) continue;
                    string name = S(k, "DisplayName");
                    if (name == null || N(k, "SystemComponent") == 1 || S(k, "ParentKeyName") != null) continue;
                    string rt = S(k, "ReleaseType");
                    if (rt != null && (rt.IndexOf("update", StringComparison.OrdinalIgnoreCase) >= 0 || rt.IndexOf("hotfix", StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                    bool msi = N(k, "WindowsInstaller") == 1;
                    string cmd = S(k, "UninstallString");
                    if (msi && IsGuid(key)) cmd = "MsiExec.exe /X" + key;
                    if (cmd == null) continue;
                    string ver = S(k, "DisplayVersion");
                    if (!seen.Add(name + "|" + (ver ?? ""))) continue;
                    string iconSpec = S(k, "DisplayIcon");
                    if (iconSpec == null && msi && IsGuid(key)) iconSpec = MsiProductIcon(key);
                    parts.Add("{\"tag\":" + VaultWin.J(tag) + ",\"key\":" + VaultWin.J(key) + ",\"name\":" + VaultWin.J(name) +
                        ",\"publisher\":" + VaultWin.J(S(k, "Publisher")) + ",\"version\":" + VaultWin.J(ver) +
                        ",\"installDate\":" + VaultWin.J(S(k, "InstallDate")) + ",\"sizeKb\":" + N(k, "EstimatedSize") +
                        ",\"icon\":" + VaultWin.J(iconSpec) + ",\"location\":" + VaultWin.J(S(k, "InstallLocation")) +
                        ",\"uninstall\":" + VaultWin.J(cmd) + ",\"noRemove\":" + (N(k, "NoRemove") == 1 ? "true" : "false") +
                        ",\"msi\":" + (msi ? "true" : "false") + ",\"url\":" + VaultWin.J(S(k, "URLInfoAbout")) +
                        ",\"help\":" + VaultWin.J(S(k, "HelpLink")) + ",\"comments\":" + VaultWin.J(S(k, "Comments")) + "}");
                }
                catch { }
                finally { if (k != null) k.Close(); }
            }
        }
        catch { }
        finally { if (un != null) un.Close(); if (root != null) root.Close(); }
    }

    /** Windows Installer keeps each product's icon under Installer\Products\<packed product code>\ProductIcon. */
    static string MsiProductIcon(string guid)
    {
        string g = guid.Trim('{', '}').Replace("-", "");
        if (g.Length != 32) return null;
        var sb = new StringBuilder();
        Action<int, int> rev = (start, len) => { for (int i = start + len - 1; i >= start; i--) sb.Append(g[i]); };
        rev(0, 8); rev(8, 4); rev(12, 4);
        for (int i = 16; i < 32; i += 2) { sb.Append(g[i + 1]); sb.Append(g[i]); }
        string packed = sb.ToString();
        foreach (string where in new[] { @"HKLM|SOFTWARE\Classes\Installer\Products\", @"HKCU|Software\Microsoft\Installer\Products\" })
        {
            string[] w = where.Split('|');
            try
            {
                using (var root = Microsoft.Win32.RegistryKey.OpenBaseKey(w[0] == "HKLM" ? Microsoft.Win32.RegistryHive.LocalMachine : Microsoft.Win32.RegistryHive.CurrentUser, Microsoft.Win32.RegistryView.Registry64))
                using (var k = root.OpenSubKey(w[1] + packed))
                {
                    if (k == null) continue;
                    string icon = S(k, "ProductIcon");
                    if (icon != null) return icon;
                }
            }
            catch { }
        }
        return null;
    }

    public static int Exists(string[] a)
    {
        if (a.Length < 3) throw new ArgumentException("appexists <tag> <key>");
        using (var root = Root(a[1]))
        using (var k = root.OpenSubKey(UNINSTALL + "\\" + a[2]))
            VaultWin.Out(k != null ? "true" : "false");
        return 0;
    }

    // ---------- launch history: Explorer's UserAssist (ROT13 names, count at 4, last run FILETIME at 60) ----------
    [DllImport("shell32.dll")]
    static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);

    static string KnownFolder(string g)
    {
        try
        {
            IntPtr p;
            if (SHGetKnownFolderPath(new Guid(g), 0, IntPtr.Zero, out p) == 0) { string s = Marshal.PtrToStringUni(p); Marshal.FreeCoTaskMem(p); return s; }
        }
        catch { }
        return null;
    }

    static string Rot13(string s)
    {
        var c = s.ToCharArray();
        for (int i = 0; i < c.Length; i++)
        {
            char x = c[i];
            if (x >= 'a' && x <= 'z') c[i] = (char)('a' + (x - 'a' + 13) % 26);
            else if (x >= 'A' && x <= 'Z') c[i] = (char)('A' + (x - 'A' + 13) % 26);
        }
        return new string(c);
    }

    static object wsh;
    static string LinkTarget(string lnk)
    {
        try
        {
            if (!File.Exists(lnk)) return null;
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (wsh == null) wsh = Activator.CreateInstance(t);
            object s = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, wsh, new object[] { lnk });
            string target = (string)s.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, s, null);
            return string.IsNullOrEmpty(target) ? null : target;
        }
        catch { return null; }
    }

    static List<string> UserAssist()
    {
        var list = new List<string>();
        try
        {
            using (var ua = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist"))
            {
                if (ua == null) return list;
                foreach (string g in ua.GetSubKeyNames())
                {
                    using (var c = ua.OpenSubKey(g + @"\Count"))
                    {
                        if (c == null) continue;
                        foreach (string vn in c.GetValueNames())
                        {
                            string n = Rot13(vn);
                            if (n.StartsWith("{"))
                            {
                                int e = n.IndexOf('}');
                                if (e > 0 && n.Length > e + 1 && n[e + 1] == '\\') { string kf = KnownFolder(n.Substring(1, e - 1)); if (kf != null) n = kf + n.Substring(e + 1); }
                            }
                            // Start menu / taskbar launches are recorded against the shortcut: follow it to the program.
                            if (n.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) && n.IndexOf(":\\") == 1)
                            {
                                string target = LinkTarget(n);
                                if (target == null) continue;
                                n = target;
                            }
                            if (!n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || n.IndexOf(":\\") != 1) continue;
                            var d = c.GetValue(vn) as byte[];
                            if (d == null || d.Length < 68) continue;
                            int count = BitConverter.ToInt32(d, 4);
                            long ft = BitConverter.ToInt64(d, 60);
                            string last = null;
                            if (ft > 0) { try { last = DateTime.FromFileTimeUtc(ft).ToString("o"); } catch { } }
                            if (count <= 0 && last == null) continue;
                            list.Add("{\"path\":" + VaultWin.J(n) + ",\"count\":" + count + ",\"last\":" + VaultWin.J(last) + "}");
                        }
                    }
                }
            }
        }
        catch { }
        return list;
    }

    // ---------- icons ----------
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint n, uint flags);
    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr h);

    public static int Icons(string[] a)
    {
        if (a.Length < 3) throw new ArgumentException("appicons <listFile> <size>");
        int size = int.Parse(a[2]), ok = 0;
        foreach (string line in File.ReadAllLines(a[1], Encoding.UTF8))
        {
            string[] t = line.Split('\t');
            if (t.Length < 2) continue;
            try { if (SaveIcon(t[1], t[0], size)) ok++; } catch { }
        }
        VaultWin.Out(ok.ToString());
        return 0;
    }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
    [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, ref BITMAP bm);
    [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, uint usage);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);

    /** The shell's own icon for a file (what Explorer shows), alpha intact. */
    static Bitmap ShellIcon(string file, int size)
    {
        try
        {
            IShellItemImageFactory f;
            SHCreateItemFromParsingName(file, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
            IntPtr hbm;
            var sz = new SIZE(); sz.cx = size; sz.cy = size;
            if (f.GetImage(sz, 0x4 /* SIIGBF_ICONONLY */, out hbm) != 0 || hbm == IntPtr.Zero) return null;
            try { return Pixels(hbm, true); } finally { DeleteObject(hbm); }
        }
        catch { return null; }
    }

    static Bitmap IconBitmap(IntPtr hicon)
    {
        ICONINFO ii;
        if (!GetIconInfo(hicon, out ii)) return null;
        try
        {
            Bitmap b = ii.hbmColor != IntPtr.Zero ? Pixels(ii.hbmColor, false) : null;
            if (b != null) return b;
            using (var ic = Icon.FromHandle(hicon)) return new Bitmap(ic.ToBitmap());
        }
        finally { if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor); if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask); }
    }

    /** Copy a 32-bit HBITMAP's pixels (with alpha) into a Bitmap; GDI+'s FromHbitmap would drop the alpha. */
    static Bitmap Pixels(IntPtr hbm, bool premultiplied)
    {
        var bm = new BITMAP();
        if (GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), ref bm) == 0 || bm.bmBitsPixel != 32) return null;
        int w = bm.bmWidth, h = Math.Abs(bm.bmHeight);
        var bi = new BITMAPINFOHEADER();
        bi.biSize = 40; bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
        var px = new byte[w * h * 4];
        IntPtr dc = GetDC(IntPtr.Zero);
        try { if (GetDIBits(dc, hbm, 0, (uint)h, px, ref bi, 0) == 0) return null; } finally { ReleaseDC(IntPtr.Zero, dc); }
        bool anyAlpha = false;
        for (int i = 3; i < px.Length; i += 4) if (px[i] != 0) { anyAlpha = true; break; }
        if (!anyAlpha) return null;
        var fmt = premultiplied ? System.Drawing.Imaging.PixelFormat.Format32bppPArgb : System.Drawing.Imaging.PixelFormat.Format32bppArgb;
        var tmp = new Bitmap(w, h, fmt);
        var data = tmp.LockBits(new Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.WriteOnly, fmt);
        for (int y = 0; y < h; y++) Marshal.Copy(px, y * w * 4, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), w * 4);
        tmp.UnlockBits(data);
        if (!premultiplied) return tmp;
        var outBmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(outBmp)) g.DrawImage(tmp, 0, 0, w, h);
        tmp.Dispose();
        return outBmp;
    }

    static bool SaveIcon(string spec, string outPath, int size)
    {
        string file = spec.Trim();
        int index = 0;
        if (file.StartsWith("\""))
        {
            int q = file.IndexOf('"', 1);
            string rest = q > 0 ? file.Substring(q + 1).Trim() : "";
            file = q > 0 ? file.Substring(1, q - 1) : file.Trim('"');
            if (rest.StartsWith(",")) int.TryParse(rest.Substring(1).Trim(), out index);
        }
        else
        {
            int c = file.LastIndexOf(',');
            int ix;
            if (c > 2 && int.TryParse(file.Substring(c + 1).Trim(), out ix)) { index = ix; file = file.Substring(0, c).Trim(); }
        }
        file = Environment.ExpandEnvironmentVariables(file);
        if (!File.Exists(file)) return false;
        Bitmap bmp = null;
        // Index 0 (the usual case) and .ico files: ask the shell, which handles PNG-compressed and 256px icons.
        if (index == 0 || file.EndsWith(".ico", StringComparison.OrdinalIgnoreCase)) bmp = ShellIcon(file, size);
        if (bmp == null)
        {
            var h = new IntPtr[1];
            var ids = new uint[1];
            uint n = PrivateExtractIcons(file, index, size, size, h, ids, 1, 0);
            if (n > 0 && n != 0xFFFFFFFF && h[0] != IntPtr.Zero) { bmp = IconBitmap(h[0]); DestroyIcon(h[0]); }
        }
        if (bmp == null) bmp = ShellIcon(file, size);
        if (bmp == null) return false;
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        bmp.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
        bmp.Dispose();
        return true;
    }

    // ---------- uninstall ----------
    static void Split(string cmd, out string file, out string args)
    {
        if (cmd.StartsWith("\""))
        {
            int q = cmd.IndexOf('"', 1);
            if (q > 0) { file = cmd.Substring(1, q - 1); args = cmd.Substring(q + 1).Trim(); return; }
        }
        string[] t = cmd.Split(' ');
        for (int i = t.Length; i >= 1; i--)
        {
            string c = string.Join(" ", t, 0, i);
            if (File.Exists(c) || (!c.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(c + ".exe")))
            { file = c; args = string.Join(" ", t, i, t.Length - i).Trim(); return; }
        }
        file = t[0];
        args = string.Join(" ", t, 1, t.Length - 1).Trim();
    }

    public static int Uninstall(string[] a)
    {
        if (a.Length < 2) throw new ArgumentException("uninstall <commandLine>");
        string file, args;
        Split(Environment.ExpandEnvironmentVariables(a[1].Trim()), out file, out args);
        var psi = new ProcessStartInfo(file, args);
        psi.UseShellExecute = true;
        try { if (Path.IsPathRooted(file)) psi.WorkingDirectory = Path.GetDirectoryName(file); } catch { }
        Process p;
        try { p = Process.Start(psi); }
        catch (System.ComponentModel.Win32Exception e)
        {
            if (e.NativeErrorCode == 1223) { VaultWin.Out("{\"ok\":false,\"cancelled\":true}"); return 0; }
            VaultWin.Out("{\"ok\":false,\"error\":" + VaultWin.J(e.Message) + "}");
            return 0;
        }
        if (p == null) { VaultWin.Out("{\"ok\":true,\"code\":null}"); return 0; }
        p.WaitForExit();
        string code = "null";
        try { code = p.ExitCode.ToString(); } catch { }
        VaultWin.Out("{\"ok\":true,\"code\":" + code + "}");
        return 0;
    }
}
