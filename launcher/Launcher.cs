// 저장소 최상단의 실행용 exe 런처 -- 2026-11-01
//
// 파이프라인을 PyInstaller로 통째로 묶지 않고, 이미 깔린 venv의 python으로 demo\test 스크립트를
// 띄워 주기만 한다. 통째로 묶으면 torch/CUDA 때문에 수 GB가 되고, 서비스 파일 맨 위의 ctypes.CDLL
// 우회와 Path(__file__).parents[2] 기준 경로가 깨질 수 있어서다.
//
// 경로는 exe 자신이 있는 폴더(=저장소 루트) 기준이라 저장소 폴더를 옮겨도 그대로 돈다.
// 어떤 스크립트를 띄울지는 빌드할 때 /define:API_SERVER, ROBOT_DOOR, ROBOT_BOX 중 하나로 정한다(build.ps1).
// exe 뒤에 인자를 붙이면 기본 인자 뒤에 그대로 넘긴다(예: API서버_실행.exe --port 8001).
//
// .NET Framework 4의 csc(C# 5)로 빌드하므로 문자열 보간 등 최신 문법은 쓰지 않는다.

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class Launcher
{
#if API_SERVER
    const string Title = "관제 웹용 HTTP 창구 (detect_api_server)";
    const string Script = "detect_api_server.py";
    const string DefaultArgs = "--port 8000";
#elif ROBOT_DOOR
    const string Title = "로봇 실연동 - 문 탐지 (mqtt_stream_receiver --target door)";
    const string Script = "mqtt_stream_receiver.py";
    const string DefaultArgs = "--target door";
#elif ROBOT_BOX
    const string Title = "로봇 실연동 - 박스 탐지 (mqtt_box_receiver, 학습 YOLO)";
    const string Script = "mqtt_box_receiver.py";
    const string DefaultArgs = "";
#else
#error 빌드할 때 /define:API_SERVER, ROBOT_DOOR, ROBOT_BOX 중 하나가 필요하다
#endif

    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string python = Path.Combine(root, @"venv\Scripts\python.exe");
        string workDir = Path.Combine(root, @"demo\test");

        Console.Title = Title;
        Console.WriteLine("[launcher] " + Title);

        if (!File.Exists(python))
            return Fail("venv python이 없다: " + python + "\n설치실행가이드_261021.md 2-4~2-6대로 venv를 먼저 만든다.");
        if (!File.Exists(Path.Combine(workDir, Script)))
            return Fail("스크립트가 없다: " + Path.Combine(workDir, Script) + "\nexe를 저장소 최상단에 두었는지 확인한다.");

        StringBuilder argLine = new StringBuilder("-u " + Script + " " + DefaultArgs);
        foreach (string a in args)
            argLine.Append(" ").Append(Quote(a));

        Console.WriteLine("[launcher] " + workDir + "> python " + argLine);
        Console.WriteLine("[launcher] 멈추려면 Ctrl + C");
        Console.WriteLine();

        // Ctrl+C는 같은 콘솔의 python에도 전달된다. 런처가 먼저 죽으면 python이 정리하는 로그를 못 보니
        // 런처는 Ctrl+C를 무시하고 python이 끝날 때까지 기다린다.
        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e) { e.Cancel = true; };

        ProcessStartInfo psi = new ProcessStartInfo(python, argLine.ToString());
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;   // 같은 콘솔 창에 출력
        // 활성화 스크립트 없이 venv python을 바로 부르므로 venv의 Scripts를 PATH 앞에 넣어 둔다.
        psi.EnvironmentVariables["PATH"] = Path.Combine(root, @"venv\Scripts") + ";" + Environment.GetEnvironmentVariable("PATH");
        psi.EnvironmentVariables["VIRTUAL_ENV"] = Path.Combine(root, "venv");

        int code;
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            code = p.ExitCode;
        }

        // 더블클릭으로 띄웠으면 창이 바로 닫혀 오류를 못 보므로 항상 멈춘다.
        Console.WriteLine();
        Console.WriteLine("[launcher] 종료 코드 " + code + " -- 아무 키나 누르면 창이 닫힌다");
        Console.ReadKey(true);
        return code;
    }

    static int Fail(string msg)
    {
        Console.WriteLine("[launcher] 실행 불가: " + msg);
        Console.WriteLine("[launcher] 아무 키나 누르면 창이 닫힌다");
        Console.ReadKey(true);
        return 1;
    }

    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
            return a;
        return "\"" + a.Replace("\"", "\\\"") + "\"";
    }
}
