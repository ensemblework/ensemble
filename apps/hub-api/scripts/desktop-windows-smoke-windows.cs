// Windows for the Windows desktop smoke test (scripts/desktop-windows-smoke.ts), compiled by Windows PowerShell 5.1's
// Add-Type (C# 5) into Ensemble.exe and copied under other names. None takes the focus when it shows.
//   ensemble x y w h  px py pw ph  trigger  "Ensemble" with an Allow button and a Notes box, and an untitled popup on
//                                           top at px py pw ph; it takes the keyboard when the trigger file appears
//   cover x y w h                           "Cover", on top, cloaked by DWM as a window on another virtual desktop is
//   overlay x y w h                         "Overlay", on top
//   browser x y w h                         "Today · Ensemble - Iron" with an Approve button
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class QuietForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}

public static class SmokeWindows {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);

  static QuietForm Placed(string title, string[] args, int from) {
    QuietForm form = new QuietForm();
    form.Text = title;
    form.StartPosition = FormStartPosition.Manual;
    form.Bounds = new Rectangle(int.Parse(args[from]), int.Parse(args[from + 1]), int.Parse(args[from + 2]), int.Parse(args[from + 3]));
    return form;
  }

  [STAThread]
  public static void Main(string[] args) {
    string mode = args[0];
    QuietForm form;
    if (mode == "ensemble") {
      form = Placed("Ensemble", args, 1);
      Button allow = new Button();
      allow.Text = "Allow";
      allow.SetBounds(20, 20, 160, 60);
      form.Controls.Add(allow);
      TextBox notes = new TextBox();
      notes.AccessibleName = "Notes";
      notes.SetBounds(20, 100, 300, 30);
      form.Controls.Add(notes);
      QuietForm popup = Placed("", args, 5);
      popup.FormBorderStyle = FormBorderStyle.None;
      popup.ShowInTaskbar = false;
      popup.TopMost = true;
      popup.BackColor = Color.SteelBlue;
      string trigger = args[9];
      Timer timer = new Timer();
      timer.Interval = 30;
      timer.Tick += delegate {
        if (!File.Exists(trigger)) return;
        File.Delete(trigger);
        uint me = GetCurrentThreadId();
        uint other = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool attached = other != 0 && other != me && AttachThreadInput(me, other, true);
        SetForegroundWindow(form.Handle);
        if (attached) AttachThreadInput(me, other, false);
      };
      form.Shown += delegate {
        popup.Show();
        timer.Start();
      };
    } else if (mode == "cover") {
      form = Placed("Cover", args, 1);
      form.TopMost = true;
      form.Shown += delegate {
        int on = 1;
        DwmSetWindowAttribute(form.Handle, 13, ref on, 4);
      };
    } else if (mode == "overlay") {
      form = Placed("Overlay", args, 1);
      form.TopMost = true;
    } else {
      form = Placed("Today \u00B7 Ensemble - Iron", args, 1);
      Button approve = new Button();
      approve.Text = "Approve";
      approve.SetBounds(20, 20, 160, 60);
      form.Controls.Add(approve);
    }
    Application.Run(form);
  }
}
