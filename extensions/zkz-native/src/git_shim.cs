using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

// 站在真正的 git.exe 前面。只拦会用别的提交覆盖工作区的命令：
// 切分支、拉取、合并、变基、拣选、还原，以及 reset 的 --hard、--merge、--keep。
// show、diff、blame、log 补上 --textconv，并丢掉关掉 textconv 的参数。
// 其余命令直接转给真正的 Git，避免 status 每次都启动 node。
class GitShim
{
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string jsonPath = Path.Combine(dir, "git-shim.json");
        string json = File.Exists(jsonPath) ? File.ReadAllText(jsonPath) : "";
        string realGit = JsonString(json, "realGit");
        if (string.IsNullOrEmpty(realGit) || !File.Exists(realGit)) realGit = FindRealGit();
        if (string.IsNullOrEmpty(realGit))
        {
            Console.Error.WriteLine("zkz-local: 找不到真正的 git.exe");
            return 1;
        }
        string[] gitArgs = ForceTextconv(args);
        bool inside = Environment.GetEnvironmentVariable("ZKZ_INSIDE_SHIM") == "1";
        if (inside || !Wraps(args)) return Run(realGit, gitArgs, true, null, null);
        string node = JsonString(json, "node");
        string script = JsonString(json, "script");
        if (string.IsNullOrEmpty(node) || string.IsNullOrEmpty(script) || !File.Exists(node) || !File.Exists(script))
        {
            Console.Error.WriteLine("zkz-local: git 替身还没有配置 node");
            return Run(realGit, gitArgs, true, null, null);
        }
        string token = Guid.NewGuid().ToString("N");
        int prep = Run(node, Prefix(script, "shim-prepare", args), false, realGit, token);
        if (prep != 0)
        {
            Run(node, Prefix(script, "shim-restore", args), false, realGit, token);
            return prep;
        }
        int code = Run(realGit, gitArgs, true, realGit, null);
        Run(node, Prefix(script, "shim-restore", args), false, realGit, token);
        return code;
    }

    static bool Wraps(string[] args)
    {
        string command = CommandOf(args);
        if (command == "checkout" || command == "switch" || command == "merge"
            || command == "pull" || command == "rebase"
            || command == "cherry-pick" || command == "revert") return true;
        // 只有这三档会改工作区。--soft 和默认的 --mixed 只动 HEAD 或索引。
        if (command != "reset") return false;
        int start = CommandIndex(args);
        for (int i = start + 1; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--") break;
            if (a == "--hard" || a == "--merge" || a == "--keep") return true;
        }
        return false;
    }

    static string CommandOf(string[] args)
    {
        int i = CommandIndex(args);
        return i < 0 ? "" : args[i];
    }

    // 命令词在参数里的位置。前面的全局选项要跳过。
    static int CommandIndex(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--") return i + 1 < args.Length ? i + 1 : -1;
            if (a == "-c" || a == "-C" || a == "--git-dir" || a == "--work-tree"
                || a == "--namespace" || a == "--super-prefix" || a == "--config-env")
            {
                i++;
                continue;
            }
            if (a.StartsWith("--git-dir=") || a.StartsWith("--work-tree=") || a.StartsWith("--namespace=")
                || a.StartsWith("--config-env=") || a.StartsWith("--exec-path=")) continue;
            if (a.StartsWith("-C") && a.Length > 2) continue;
            if (a == "--exec-path")
            {
                if (i + 1 < args.Length && !args[i + 1].StartsWith("-")) i++;
                continue;
            }
            if (a.StartsWith("-")) continue;
            return i;
        }
        return -1;
    }

    static readonly Regex BlankTextconvRe = new Regex("^diff\\.[^.=]+\\.textconv=(.*)$");

    // diff.<驱动>.textconv 被设成空。返回是否丢掉。替身进程调用。
    static bool BlankTextconvAssignment(string text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        Match m = BlankTextconvRe.Match(text);
        if (!m.Success) return false;
        string v = m.Groups[1].Value.Trim();
        return v.Length == 0 || v == "\"\"" || v == "''";
    }

    static bool IsTextconvCommand(string command)
    {
        return command == "show" || command == "diff" || command == "blame" || command == "log";
    }

    // 给 show/diff/blame/log 补上 --textconv，去掉 --no-textconv 和把驱动设空的 -c。返回新参数。替身进程调用。
    static string[] ForceTextconv(string[] args)
    {
        int cmdAt = CommandIndex(args);
        string command = cmdAt < 0 ? "" : args[cmdAt];
        if (!IsTextconvCommand(command)) return args;
        int end = args.Length;
        for (int i = cmdAt + 1; i < args.Length; i++)
        {
            if (args[i] == "--")
            {
                end = i;
                break;
            }
        }
        List<string> kept = new List<string>();
        for (int i = 0; i < end; i++)
        {
            string a = args[i];
            if (i < cmdAt && a == "-c" && i + 1 < end && BlankTextconvAssignment(args[i + 1]))
            {
                i++;
                continue;
            }
            if (i < cmdAt && a.Length > 2 && a.StartsWith("-c") && BlankTextconvAssignment(a.Substring(2))) continue;
            if (a == "--no-textconv") continue;
            kept.Add(a);
        }
        bool has = false;
        for (int i = 0; i < kept.Count; i++) if (kept[i] == "--textconv") has = true;
        if (!has)
        {
            int again = CommandIndex(kept.ToArray());
            if (again >= 0) kept.Insert(again + 1, "--textconv");
        }
        for (int i = end; i < args.Length; i++) kept.Add(args[i]);
        return kept.ToArray();
    }

    static bool BlankTextconvKey(string key, string value)
    {
        return BlankTextconvAssignment((key ?? "") + "=" + (value ?? ""));
    }

    // 丢掉 GIT_CONFIG_* 里把 diff.<驱动>.textconv 设空的项。无返回值。替身进程调用。
    static void StripBlankTextconvEnv(ProcessStartInfo psi)
    {
        int count;
        if (!int.TryParse(psi.EnvironmentVariables["GIT_CONFIG_COUNT"], out count) || count <= 0) return;
        List<string> keys = new List<string>();
        List<string> vals = new List<string>();
        for (int i = 0; i < count; i++)
        {
            string key = psi.EnvironmentVariables["GIT_CONFIG_KEY_" + i] ?? "";
            string val = psi.EnvironmentVariables["GIT_CONFIG_VALUE_" + i] ?? "";
            if (BlankTextconvKey(key, val)) continue;
            keys.Add(key);
            vals.Add(val);
        }
        for (int i = 0; i < count; i++)
        {
            psi.EnvironmentVariables.Remove("GIT_CONFIG_KEY_" + i);
            psi.EnvironmentVariables.Remove("GIT_CONFIG_VALUE_" + i);
        }
        if (keys.Count == 0)
        {
            psi.EnvironmentVariables.Remove("GIT_CONFIG_COUNT");
            return;
        }
        psi.EnvironmentVariables["GIT_CONFIG_COUNT"] = keys.Count.ToString();
        for (int i = 0; i < keys.Count; i++)
        {
            psi.EnvironmentVariables["GIT_CONFIG_KEY_" + i] = keys[i];
            psi.EnvironmentVariables["GIT_CONFIG_VALUE_" + i] = vals[i];
        }
    }

    static string[] Prefix(string script, string mode, string[] args)
    {
        string[] all = new string[args.Length + 2];
        all[0] = script;
        all[1] = mode;
        Array.Copy(args, 0, all, 2, args.Length);
        return all;
    }

    static string FindRealGit()
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        string[] dirs = path.Split(';');
        for (int i = 0; i < dirs.Length; i++)
        {
            string dir = dirs[i].Trim();
            if (dir.Length == 0) continue;
            string candidate = Path.Combine(dir, "git.exe");
            if (!File.Exists(candidate)) continue;
            if (string.Equals(Path.GetFullPath(candidate), Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase)) continue;
            return candidate;
        }
        return null;
    }

    static string JsonString(string json, string key)
    {
        if (string.IsNullOrEmpty(json)) return null;
        Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        if (!m.Success) return null;
        return m.Groups[1].Value.Replace("\\\\", "\\").Replace("\\/", "/").Replace("\\\"", "\"");
    }

    static int Run(string file, string[] args, bool insideGit, string realGit, string token)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = file;
        psi.Arguments = JoinArgs(args);
        psi.UseShellExecute = false;
        if (!string.IsNullOrEmpty(realGit)) psi.EnvironmentVariables["ZKZ_REAL_GIT"] = realGit;
        if (insideGit) psi.EnvironmentVariables["ZKZ_INSIDE_SHIM"] = "1";
        if (!string.IsNullOrEmpty(token)) psi.EnvironmentVariables["ZKZ_SHIM_TOKEN"] = token;
        if (insideGit && IsTextconvCommand(CommandOf(args))) StripBlankTextconvEnv(psi);
        try
        {
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("zkz-local: " + ex.Message);
            return 1;
        }
    }

    static string JoinArgs(string[] args)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(Quote(args[i] ?? ""));
        }
        return sb.ToString();
    }

    static string Quote(string s)
    {
        if (s.Length == 0) return "\"\"";
        if (s.IndexOf(' ') < 0 && s.IndexOf('\t') < 0 && s.IndexOf('"') < 0) return s;
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int bs = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '\\') { bs++; continue; }
            if (c == '"')
            {
                sb.Append('\\', bs * 2 + 1);
                sb.Append('"');
                bs = 0;
                continue;
            }
            if (bs > 0) { sb.Append('\\', bs); bs = 0; }
            sb.Append(c);
        }
        if (bs > 0) sb.Append('\\', bs * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
