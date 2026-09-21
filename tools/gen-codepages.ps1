<#
.SYNOPSIS
    Regenerates src/core/codepages.generated.ts from .NET's own single-byte code pages.

.DESCRIPTION
    The viewer renders one byte as one character, so it needs a byte -> Unicode table per code page.
    Node has none for EBCDIC, and an npm package would be one more thing to trust for the exact
    mapping the runtime already uses: .NET's CodePagesEncodingProvider holds the same tables
    RainCodeLegacyRuntimeUtils decodes with, so they are taken from there and committed.

    Pages are listed by CCSID - the number written on a mainframe dataset and typed by a user - and
    resolved through the Windows code page it maps to, the way CCSIDConverter does. Several of them
    differ (CCSID 273 is Windows 20273, CCSID 1026 is Windows 20905), and asking .NET for the CCSID
    directly simply fails for those.

    Run it with PowerShell 7 when a code page has to be added to the list below.
#>

param (
    [string] $Output = (Join-Path $PSScriptRoot "../src/core/codepages.generated.ts")
)

$ErrorActionPreference = "Stop"

[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)

# EBCDIC first: that is what a mainframe dataset is written in. The ASCII-based ones are for files
# that came back the other way, or that were produced here.
$pages = @(
    @{ Ccsid = 37;   Windows = 37;    Id = "ibm037";  Label = "EBCDIC 037 - US/Canada";           Ebcdic = $true  }
    @{ Ccsid = 273;  Windows = 20273; Id = "ibm273";  Label = "EBCDIC 273 - Germany/Austria";     Ebcdic = $true  }
    @{ Ccsid = 277;  Windows = 20277; Id = "ibm277";  Label = "EBCDIC 277 - Denmark/Norway";      Ebcdic = $true  }
    @{ Ccsid = 278;  Windows = 20278; Id = "ibm278";  Label = "EBCDIC 278 - Finland/Sweden";      Ebcdic = $true  }
    @{ Ccsid = 280;  Windows = 20280; Id = "ibm280";  Label = "EBCDIC 280 - Italy";               Ebcdic = $true  }
    @{ Ccsid = 284;  Windows = 20284; Id = "ibm284";  Label = "EBCDIC 284 - Spain/Latin America"; Ebcdic = $true  }
    @{ Ccsid = 285;  Windows = 20285; Id = "ibm285";  Label = "EBCDIC 285 - United Kingdom";      Ebcdic = $true  }
    @{ Ccsid = 297;  Windows = 20297; Id = "ibm297";  Label = "EBCDIC 297 - France";              Ebcdic = $true  }
    @{ Ccsid = 500;  Windows = 500;   Id = "ibm500";  Label = "EBCDIC 500 - International";       Ebcdic = $true  }
    @{ Ccsid = 870;  Windows = 870;   Id = "ibm870";  Label = "EBCDIC 870 - Latin 2";             Ebcdic = $true  }
    @{ Ccsid = 871;  Windows = 20871; Id = "ibm871";  Label = "EBCDIC 871 - Iceland";             Ebcdic = $true  }
    @{ Ccsid = 875;  Windows = 875;   Id = "ibm875";  Label = "EBCDIC 875 - Greek";               Ebcdic = $true  }
    @{ Ccsid = 1025; Windows = 21025; Id = "ibm1025"; Label = "EBCDIC 1025 - Cyrillic";           Ebcdic = $true  }
    @{ Ccsid = 1026; Windows = 20905; Id = "ibm1026"; Label = "EBCDIC 1026 - Turkish";            Ebcdic = $true  }
    @{ Ccsid = 1047; Windows = 1047;  Id = "ibm1047"; Label = "EBCDIC 1047 - Open Systems";       Ebcdic = $true  }
    @{ Ccsid = 1140; Windows = 1140;  Id = "ibm1140"; Label = "EBCDIC 1140 - US/Canada, euro";    Ebcdic = $true  }
    @{ Ccsid = 1141; Windows = 1141;  Id = "ibm1141"; Label = "EBCDIC 1141 - Germany, euro";      Ebcdic = $true  }
    @{ Ccsid = 1142; Windows = 1142;  Id = "ibm1142"; Label = "EBCDIC 1142 - Denmark, euro";      Ebcdic = $true  }
    @{ Ccsid = 1143; Windows = 1143;  Id = "ibm1143"; Label = "EBCDIC 1143 - Finland, euro";      Ebcdic = $true  }
    @{ Ccsid = 1144; Windows = 1144;  Id = "ibm1144"; Label = "EBCDIC 1144 - Italy, euro";        Ebcdic = $true  }
    @{ Ccsid = 1145; Windows = 1145;  Id = "ibm1145"; Label = "EBCDIC 1145 - Spain, euro";        Ebcdic = $true  }
    @{ Ccsid = 1146; Windows = 1146;  Id = "ibm1146"; Label = "EBCDIC 1146 - UK, euro";           Ebcdic = $true  }
    @{ Ccsid = 1147; Windows = 1147;  Id = "ibm1147"; Label = "EBCDIC 1147 - France, euro";       Ebcdic = $true  }
    @{ Ccsid = 1148; Windows = 1148;  Id = "ibm1148"; Label = "EBCDIC 1148 - International, euro"; Ebcdic = $true }
    @{ Ccsid = 1149; Windows = 1149;  Id = "ibm1149"; Label = "EBCDIC 1149 - Iceland, euro";      Ebcdic = $true  }
    @{ Ccsid = 1252; Windows = 1252;  Id = "windows1252"; Label = "Windows-1252 - Latin 1";       Ebcdic = $false }
    @{ Ccsid = 819;  Windows = 28591; Id = "iso88591"; Label = "ISO 8859-1 - Latin 1";            Ebcdic = $false }
    @{ Ccsid = 850;  Windows = 850;   Id = "ibm850";  Label = "OEM 850 - Latin 1";                Ebcdic = $false }
    @{ Ccsid = 437;  Windows = 437;   Id = "ibm437";  Label = "OEM 437 - US";                     Ebcdic = $false }
)

function Format-Chars([System.Text.Encoding] $encoding) {
    $sb = [System.Text.StringBuilder]::new()
    for ($i = 0; $i -lt 256; $i++) {
        $decoded = $encoding.GetString([byte[]] @($i))
        # One byte must give exactly one character, or the column model this viewer is built on does
        # not hold - so say so rather than emit a table that silently misaligns.
        if ($decoded.Length -ne 1) {
            throw "Code page $($encoding.CodePage): byte $i decoded to $($decoded.Length) characters."
        }
        [void] $sb.AppendFormat("\u{0:x4}", [int] $decoded[0])
    }
    return $sb.ToString()
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("// Generated by tools/gen-codepages.ps1 from .NET's CodePagesEncodingProvider. Do not edit.")
$lines.Add("//")
$lines.Add("// One entry per single-byte code page. `chars` holds the 256 characters that bytes 0..255")
$lines.Add("// decode to, in order; `ccsid` is the number a mainframe dataset is labelled with.")
$lines.Add("")
$lines.Add("export interface GeneratedCodePage {")
$lines.Add("    id: string;")
$lines.Add("    ccsid: number;")
$lines.Add("    label: string;")
$lines.Add("    ebcdic: boolean;")
$lines.Add("    chars: string;")
$lines.Add("}")
$lines.Add("")
$lines.Add("export const GENERATED_CODE_PAGES: readonly GeneratedCodePage[] = [")

foreach ($page in $pages) {
    $encoding = [System.Text.Encoding]::GetEncoding($page.Windows)
    $chars = Format-Chars $encoding
    $ebcdic = if ($page.Ebcdic) { "true" } else { "false" }
    $lines.Add("    {")
    $lines.Add("        id: '$($page.Id)',")
    $lines.Add("        ccsid: $($page.Ccsid),")
    $lines.Add("        label: '$($page.Label)',")
    $lines.Add("        ebcdic: $ebcdic,")
    $lines.Add("        chars:")
    $lines.Add("            '$chars',")
    $lines.Add("    },")
}

$lines.Add("];")
$lines.Add("")

Set-Content -Path $Output -Value ($lines -join "`n") -Encoding utf8NoBOM
Write-Host "Wrote $($pages.Count) code pages to $Output"
