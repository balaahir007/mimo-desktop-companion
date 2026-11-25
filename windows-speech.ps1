param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('listen', 'wake', 'speak', 'play', 'voices')]
  [string]$Mode,
  [string]$Language = 'en-US',
  [string]$WaveFile = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Send-Message($Message) {
  [Console]::WriteLine(($Message | ConvertTo-Json -Compress -Depth 4))
}

function Read-Request {
  $line = [Console]::ReadLine()
  if (!$line) { return [PSCustomObject]@{} }
  $bytes = [Convert]::FromBase64String($line)
  [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}

try {
  if ($Mode -eq 'play') {
    $request = Read-Request
    $stream = New-Object IO.MemoryStream(,([Convert]::FromBase64String($request.audio)))
    $player = New-Object Media.SoundPlayer($stream)
    try { $player.PlaySync(); Send-Message @{type='spoken'} }
    finally { $player.Dispose(); $stream.Dispose() }
    exit
  }
  Add-Type -AssemblyName System.Speech
  if ($Mode -in 'listen','wake') {
    $request = Read-Request
    $all = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    $recognizer = $all | Where-Object { $_.Culture.Name -eq $Language } | Select-Object -First 1
    if (!$recognizer) {
      $family = $Language.Split('-')[0]
      $recognizer = $all | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $family } | Select-Object -First 1
    }
    if (!$recognizer) {
      Send-Message @{type='error'; text='Windows speech recognition is unavailable. Install an English speech recognition language in Windows Settings, or type below.'}
      exit 2
    }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
    try {
      $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
      $engine.BabbleTimeout = [TimeSpan]::FromSeconds(8)
      $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900)
      $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1200)
      if ($Mode -eq 'listen') {
        Add-Type -ReferencedAssemblies @([System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location, 'System.Web.Extensions') -TypeDefinition @"
using System;
using System.Speech.Recognition;
using System.Web.Script.Serialization;
public static class MimoDictation {
    public static RecognitionResult Listen(SpeechRecognitionEngine engine, string[] names) {
        var free = new DictationGrammar();
        engine.LoadGrammar(free);

        var request = new GrammarBuilder { Culture = engine.RecognizerInfo.Culture };
        request.Append(new Choices("remind me to", "remind me again in", "remind me in",
            "come back after", "snooze for", "move it to", "remember that I have to", "I need to", "ask Memo", "plan this"));
        request.AppendDictation();
        engine.LoadGrammar(new Grammar(request));

        var response = new GrammarBuilder { Culture = engine.RecognizerInfo.Culture };
        var commands = new Choices("confirm", "yes", "no", "that's all", "no that's all", "no that is all", "goodbye",
            "stop listening", "done", "I completed it", "mark it complete", "dismiss", "not now");
        commands.Add("talk to Claude", "talk to chat GPT", "back to reminders", "exit chat");
        commands.Add("run workflow", "run workflow open documents", "ask n eight n");
        commands.Add("dance", "jump", "wave", "dance for me");
        foreach (var name in names ?? new string[0]) {
            commands.Add("close " + name);
            commands.Add("hide " + name);
        }
        response.Append(commands);
        engine.LoadGrammar(new Grammar(response));

        var durations = new Choices("one minute", "an hour", "half an hour");
        for (var i = 2; i <= 60; i++) durations.Add(i + " minutes");
        var snooze = new GrammarBuilder { Culture = engine.RecognizerInfo.Culture };
        snooze.Append(new Choices("remind me again in", "remind me in", "snooze for", "come back after"));
        snooze.Append(durations);
        engine.LoadGrammar(new Grammar(snooze));
        var json = new JavaScriptSerializer();
        engine.SpeechHypothesized += (sender, args) =>
            Console.WriteLine(json.Serialize(new {type="partial", text=args.Result.Text}));
        Console.WriteLine("{\"type\":\"ready\"}");
        return engine.Recognize();
    }
}
"@
      } else {
        $choices = New-Object System.Speech.Recognition.Choices
        $choices.Add([string[]]$request.phrases)
        $grammar = New-Object System.Speech.Recognition.GrammarBuilder
        $grammar.Culture = $recognizer.Culture
        $grammar.Append($choices)
        $engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($grammar)))
      }
      try {
        if ($WaveFile) { $engine.SetInputToWaveFile($WaveFile) }
        else { $engine.SetInputToDefaultAudioDevice() }
      } catch {
        Send-Message @{type='error'; text='Microphone unavailable. Check your input device and Windows microphone privacy settings, or type below.'}
        exit 2
      }
      if ($Mode -eq 'wake') {
        Send-Message @{type='ready'}
        do { $result = $engine.Recognize() }
        while (!$WaveFile -and (!$result -or $result.Confidence -lt 0.72))
      } else {
        $result = [MimoDictation]::Listen($engine, [string[]]@($request.names | Where-Object { $_ }))
      }
      if ($result) {
        Send-Message @{type='final'; text=$result.Text; confidence=$result.Confidence}
      } else {
        Send-Message @{type='empty'}
      }
    } finally { $engine.Dispose() }
  } else {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $voices = @($synth.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en'
      })
      if ($Mode -eq 'voices') {
        Send-Message @{type='voices'; voices=@($voices | ForEach-Object { $_.VoiceInfo.Name })}
      } else {
        $request = Read-Request
        $voice = $voices | Where-Object { $_.VoiceInfo.Name -eq $request.voice } | Select-Object -First 1
        if (!$voice) { $voice = $voices | Select-Object -First 1 }
        if (!$voice) { throw 'No installed English speech voice.' }
        $synth.SelectVoice($voice.VoiceInfo.Name)
        $synth.Rate = [int]$request.rate
        $synth.Volume = [int]$request.volume
        if ($WaveFile) { $synth.SetOutputToWaveFile($WaveFile) }
        else { $synth.SetOutputToDefaultAudioDevice() }
        if ($WaveFile) {
          $prompt = New-Object System.Speech.Synthesis.PromptBuilder
          $prompt.AppendText([string]$request.text)
          $prompt.AppendBreak([TimeSpan]::FromMilliseconds(1500))
          $synth.Speak($prompt)
        } else {
          $synth.Speak($request.text)
        }
        Send-Message @{type='spoken'}
      }
    } finally { $synth.Dispose() }
  }
} catch {
  $message = if ($Mode -in 'listen','wake') { 'Speech recognition is unavailable. Check Windows speech and microphone settings, or type below.' }
  else { 'Windows could not play a voice response. Check your installed English voices and output device.' }
  Send-Message @{type='error'; text=$message}
  exit 1
}
