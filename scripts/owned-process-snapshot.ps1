param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$RootProcessId)
$ErrorActionPreference = 'Stop'
# Read-only parent/PID snapshot, followed by the same .NET working-set counters
# as the CIM harness. See Microsoft's PROCESSENTRY32W/Tool Help documentation.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CountryClubProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  public sealed class Record { public uint Pid, Parent; public string Name; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool First(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool Next(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
  public static Record[] Read() {
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var records = new List<Record>();
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!First(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
      do { records.Add(new Record { Pid=entry.pid, Parent=entry.parent, Name=entry.name }); } while (Next(snapshot, ref entry));
      int error = Marshal.GetLastWin32Error();
      if (error != 18) throw new Win32Exception(error);
      return records.ToArray();
    } finally { CloseHandle(snapshot); }
  }
}
'@
$snapshot = [CountryClubProcessSnapshot]::Read()
$rootRecord = @($snapshot | Where-Object { $_.Pid -eq $RootProcessId })
if ($rootRecord.Count -ne 1) { throw 'Owned root missing from snapshot' }
$records = @($rootRecord[0])
$frontier = @($RootProcessId)
$seen = @{}
$seen[$RootProcessId] = $true
while ($frontier.Count) {
  $next = @()
  foreach ($item in $snapshot) {
    if ($frontier -contains [int]$item.Parent -and -not $seen.ContainsKey([int]$item.Pid)) {
      $seen[[int]$item.Pid] = $true
      $records += $item
      $next += [int]$item.Pid
    }
  }
  $frontier = $next
}
$result = @($records | ForEach-Object {
  $item = $_
  try {
    # A child can exit between the Tool Help snapshot and this metadata read.
    # It is already gone, so omit it rather than turning a cleanup observation
    # into a false failure.
    $ownedProcess = Get-Process -Id $item.Pid -ErrorAction Stop
    [pscustomobject]@{ pid=[int]$item.Pid; parentPid=[int]$item.Parent; name=$item.Name;
      workingSetKiB=$ownedProcess.WorkingSet64/1024; privateKiB=$ownedProcess.PrivateMemorySize64/1024;
      executable=$ownedProcess.Path; created=$ownedProcess.StartTime.ToUniversalTime().ToString('o') }
  } catch { return } finally { if ($ownedProcess) { $ownedProcess.Dispose() } }
})
$result | ConvertTo-Json -Compress
