# path to chocolatey library
$libPath = "$env:ProgramData\chocolatey\lib"

# collect installed package nuspecs
$nuspecFiles = Get-ChildItem -Path $libPath -Recurse -Filter '*.nuspec' -ErrorAction SilentlyContinue

# dictionaries
$installed = @()            # list of installed package ids
$depsByPackage = @{}        # package id -> array of dependency ids

foreach ($file in $nuspecFiles) {
    try {
        $xml = [xml](Get-Content $file.FullName -ErrorAction Stop)
        $id = $xml.package.metadata.id
        if (-not $id) { continue }

        $installed += $id

        $deps = @()
        # dependencies can be directly under metadata/dependencies or grouped
        $depNodes = @()
        if ($xml.package.metadata.dependencies.dependency) {
            $depNodes += $xml.package.metadata.dependencies.dependency
        }
        if ($xml.package.metadata.dependencies.group) {
            foreach ($g in $xml.package.metadata.dependencies.group) {
                if ($g.dependency) { $depNodes += $g.dependency }
            }
        }
        foreach ($d in $depNodes) {
            if ($d.id) { $deps += $d.id }
        }
        $depsByPackage[$id] = ($deps | Select-Object -Unique)
    } catch {
        # ignore malformed nuspecs
    }
}

$installed = $installed | Sort-Object -Unique
$allDeps = $depsByPackage.Values | ForEach-Object { $_ } | Where-Object { $_ } | Select-Object -Unique

# packages that are installed but not listed as a dependency of any installed package
$topLevel = $installed | Where-Object { $allDeps -notcontains $_ } | Sort-Object

"Top-level (explicit) Chocolatey packages:"
$topLevel | ForEach-Object { Write-Output $_ }

"----"
"Installed packages that appear as dependencies (likely auto-installed):"
$allDeps | Sort-Object
