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
    static void Out(string json) { Console.Out.Write(json); Console.Out.Flush(); }

    static string J(string s)
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
