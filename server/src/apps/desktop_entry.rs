//! Linux's desktop entries (.desktop files), read as the Desktop Entry
//! Specification says: which ones a launcher shows, what they are called in
//! the user's language, and the command their Exec line stands for.
//!
//! All of it decides and none of it does: it is shared by every platform so
//! its tests run everywhere. list.rs walks the folders with it and
//! launch.rs turns an entry into the program to start.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The keys of a file's `[Desktop Entry]` group, values as written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopEntry {
    keys: HashMap<String, String>,
}

impl DesktopEntry {
    pub fn parse(text: &str) -> DesktopEntry {
        let mut keys = HashMap::new();
        let mut inside = false;
        for line in text.lines() {
            let line = line.trim_matches([' ', '\t', '\r']);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if line.starts_with('[') {
                inside = line == "[Desktop Entry]";
                continue;
            }
            if !inside {
                continue;
            }
            // Spaces around the equals sign are not part of either side.
            if let Some((key, value)) = line.split_once('=') {
                keys.insert(
                    key.trim_end_matches([' ', '\t']).to_string(),
                    value.trim_start_matches([' ', '\t']).to_string(),
                );
            }
        }
        DesktopEntry { keys }
    }

    /// A value of type string: `\s`, `\n`, `\t`, `\r` and `\\` read as the
    /// characters they stand for.
    pub fn string(&self, key: &str) -> Option<String> {
        self.keys.get(key).map(|raw| unescape(raw))
    }

    /// A value in the user's language: `Name[es_CO]`, then `Name[es]`, then
    /// `Name`. `locales` is what [`locale_candidates`] gave.
    pub fn localized(&self, key: &str, locales: &[String]) -> Option<String> {
        locales
            .iter()
            .find_map(|locale| self.string(&format!("{key}[{locale}]")))
            .or_else(|| self.string(key))
            .filter(|value| !value.is_empty())
    }

    pub fn boolean(&self, key: &str) -> bool {
        self.keys.get(key).is_some_and(|value| value == "true")
    }

    /// A value of several strings, each ended by ";" (`\;` is a semicolon
    /// inside one).
    pub fn list(&self, key: &str) -> Vec<String> {
        let Some(raw) = self.keys.get(key) else {
            return Vec::new();
        };
        let mut items = Vec::new();
        let mut item = String::new();
        let mut chars = raw.chars();
        while let Some(c) = chars.next() {
            match c {
                ';' => items.push(std::mem::take(&mut item)),
                '\\' => match chars.next() {
                    Some(';') => item.push(';'),
                    Some(other) => {
                        item.push('\\');
                        item.push(other);
                    }
                    None => item.push('\\'),
                },
                other => item.push(other),
            }
        }
        if !item.is_empty() {
            items.push(item);
        }
        items.iter().map(|item| unescape(item)).collect()
    }

    /// Whether a launcher lists this entry: an application with a name and a
    /// command, not hidden, meant for this desktop, whose program (TryExec)
    /// is installed.
    pub fn is_shown(
        &self,
        desktops: &[String],
        path: &[PathBuf],
        is_program: &dyn Fn(&Path) -> bool,
    ) -> bool {
        let filled = |key: &str| self.string(key).is_some_and(|value| !value.is_empty());
        if self.string("Type").as_deref() != Some("Application")
            || self.boolean("NoDisplay")
            || self.boolean("Hidden")
            || !filled("Name")
            || !filled("Exec")
        {
            return false;
        }
        let among = |key: &str| self.list(key).iter().any(|name| desktops.contains(name));
        if (self.keys.contains_key("OnlyShowIn") && !among("OnlyShowIn")) || among("NotShowIn") {
            return false;
        }
        match self.string("TryExec") {
            Some(program) if !program.is_empty() => {
                find_program(&program, path, is_program).is_some()
            }
            _ => true,
        }
    }
}

/// The escapes every string value may hold.
fn unescape(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            text.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => text.push(' '),
            Some('n') => text.push('\n'),
            Some('t') => text.push('\t'),
            Some('r') => text.push('\r'),
            Some('\\') => text.push('\\'),
            // Not an escape: kept as written.
            Some(other) => {
                text.push('\\');
                text.push(other);
            }
            None => text.push('\\'),
        }
    }
    text
}

/// A file's id: its path under the applications folder, with "-" for "/"
/// ("kde/okular.desktop" is "kde-okular.desktop"). The same id in two
/// folders is the same application.
pub fn desktop_file_id(applications: &Path, file: &Path) -> String {
    let inside = file.strip_prefix(applications).unwrap_or(file);
    inside
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("-")
}

/// The names a localized key is looked up under for one locale, as the
/// specification orders them: for "sr_RS.UTF-8@latin", `sr_RS@latin`,
/// `sr_RS`, `sr@latin`, `sr`.
fn locale_variants(locale: &str) -> Vec<String> {
    let (rest, modifier) = match locale.split_once('@') {
        Some((rest, modifier)) => (rest, Some(modifier)),
        None => (locale, None),
    };
    let rest = rest.split('.').next().unwrap_or("");
    let (language, country) = match rest.split_once('_') {
        Some((language, country)) => (language, Some(country)),
        None => (rest, None),
    };
    if language.is_empty() {
        return Vec::new();
    }
    let mut variants = Vec::new();
    if let (Some(country), Some(modifier)) = (country, modifier) {
        variants.push(format!("{language}_{country}@{modifier}"));
    }
    if let Some(country) = country {
        variants.push(format!("{language}_{country}"));
    }
    if let Some(modifier) = modifier {
        variants.push(format!("{language}@{modifier}"));
    }
    variants.push(language.to_string());
    variants
}

/// The locales to look names up in, best first, from the environment: the
/// first of LC_ALL, LC_MESSAGES and LANG that is set says the language, and
/// LANGUAGE ("es_CO:es:en"), when there is one, lists several in order.
/// None for "C" and "POSIX": the plain `Name` is the name.
pub fn locale_candidates(variable: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let set = |name: &str| variable(name).filter(|value| !value.is_empty());
    let Some(locale) = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| set(name))
    else {
        return Vec::new();
    };
    if matches!(locale.split(['.', '@']).next(), Some("C" | "POSIX")) {
        return Vec::new();
    }
    let wanted = set("LANGUAGE").unwrap_or(locale);
    let mut candidates: Vec<String> = Vec::new();
    for variant in wanted.split(':').flat_map(locale_variants) {
        if !candidates.contains(&variant) {
            candidates.push(variant);
        }
    }
    candidates
}

/// Where a program is: itself if `name` is a path, else the first folder of
/// `path` that has it.
pub fn find_program(
    name: &str,
    path: &[PathBuf],
    is_program: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if name.contains('/') {
        return Some(PathBuf::from(name)).filter(|file| is_program(file));
    }
    path.iter()
        .map(|dir| dir.join(name))
        .find(|file| is_program(file))
}

// --------------------------------------------------------------- Exec

/// An Exec line that cannot be read: a quote that is never closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnclosedQuote;

/// The arguments of an Exec line (already unescaped as a string value).
///
/// The specification: arguments are separated by spaces; one with a space or
/// another reserved character is written in double quotes, inside which a
/// backslash keeps the next `"`, `` ` ``, `$` or `\` as itself. Desktops read
/// the line as a shell would, so files in the wild also use single quotes
/// (everything inside as written) and a backslash outside quotes (the next
/// character as itself); those are read too.
pub fn split_exec(exec: &str) -> Result<Vec<String>, UnclosedQuote> {
    let mut arguments = Vec::new();
    let mut argument = String::new();
    // An empty pair of quotes is an argument too.
    let mut started = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\n' => {
                if started {
                    arguments.push(std::mem::take(&mut argument));
                    started = false;
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        None => return Err(UnclosedQuote),
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            None => return Err(UnclosedQuote),
                            Some(kept @ ('"' | '`' | '$' | '\\')) => argument.push(kept),
                            Some(other) => {
                                argument.push('\\');
                                argument.push(other);
                            }
                        },
                        Some(other) => argument.push(other),
                    }
                }
            }
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        None => return Err(UnclosedQuote),
                        Some('\'') => break,
                        Some(other) => argument.push(other),
                    }
                }
            }
            '\\' => {
                started = true;
                argument.push(chars.next().unwrap_or('\\'));
            }
            other => {
                started = true;
                argument.push(other);
            }
        }
    }
    if started {
        arguments.push(argument);
    }
    Ok(arguments)
}

/// What the field codes of an Exec line stand for when an application is
/// started by itself, with no file to open.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecFields {
    /// `%i`: the entry's Icon, given as `--icon <Icon>`.
    pub icon: Option<String>,
    /// `%c`: the entry's name in the user's language.
    pub name: String,
    /// `%k`: where the .desktop file is.
    pub file: String,
}

/// The arguments with their field codes filled in.
///
/// `%f`, `%F`, `%u` and `%U` are the files or addresses to open: none here,
/// so they stand for nothing, and an argument that was only that code is
/// left out rather than passed empty. `%i` becomes two arguments, `--icon`
/// and the icon, or none without an icon. `%c` is the name, `%k` the file,
/// `%%` a percent sign. The deprecated `%d %D %n %N %v %m` and anything
/// unknown are removed.
pub fn expand_exec(arguments: &[String], fields: &ExecFields) -> Vec<String> {
    let mut expanded = Vec::new();
    for argument in arguments {
        if argument == "%i" {
            if let Some(icon) = fields.icon.as_ref().filter(|icon| !icon.is_empty()) {
                expanded.push("--icon".to_string());
                expanded.push(icon.clone());
            }
            continue;
        }
        let mut text = String::new();
        let mut had_code = false;
        let mut chars = argument.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                text.push(c);
                continue;
            }
            match chars.next() {
                Some('%') => text.push('%'),
                Some('c') => text.push_str(&fields.name),
                Some('k') => text.push_str(&fields.file),
                // Files, addresses, the icon inside another argument, the
                // deprecated codes, an unknown one, a lone % at the end.
                _ => had_code = true,
            }
        }
        if text.is_empty() && had_code {
            continue;
        }
        expanded.push(text);
    }
    expanded
}

// ----------------------------------------------------------- terminals

/// Terminal programs, the desktop's own choice first, with what each wants
/// before the command to run (nothing: the command follows directly).
const TERMINALS: [(&str, &[&str]); 16] = [
    ("xdg-terminal-exec", &[]),
    ("x-terminal-emulator", &["-e"]),
    ("gnome-terminal", &["--"]),
    ("kgx", &["--"]),
    ("ptyxis", &["--"]),
    ("konsole", &["-e"]),
    ("xfce4-terminal", &["-x"]),
    ("mate-terminal", &["-x"]),
    ("lxterminal", &["-e"]),
    ("tilix", &["-e"]),
    ("terminator", &["-x"]),
    ("alacritty", &["-e"]),
    ("kitty", &[]),
    ("foot", &[]),
    ("wezterm", &["start", "--"]),
    ("xterm", &["-e"]),
];

/// The terminal to run a `Terminal=true` entry in: the one $TERMINAL names
/// if it is installed, else the first known one that is.
pub fn find_terminal(preferred: Option<&str>, installed: &dyn Fn(&str) -> bool) -> Option<String> {
    preferred
        .filter(|name| !name.is_empty() && installed(name))
        .or_else(|| {
            TERMINALS
                .iter()
                .map(|(name, _)| *name)
                .find(|name| installed(name))
        })
        .map(str::to_string)
}

/// The command that runs `command` inside `terminal`. A terminal this does
/// not know is given `-e`, which nearly all of them take.
pub fn in_terminal(terminal: &str, command: &[String]) -> Vec<String> {
    let program = terminal.rsplit('/').next().unwrap_or(terminal);
    let before: &[&str] = TERMINALS
        .iter()
        .find(|(name, _)| *name == program)
        .map_or(&["-e"], |(_, before)| before);
    let mut line = vec![terminal.to_string()];
    line.extend(before.iter().map(|flag| flag.to_string()));
    line.extend(command.iter().cloned());
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn split(exec: &str) -> Vec<String> {
        split_exec(exec).expect("the line can be read")
    }

    #[test]
    fn only_the_desktop_entry_group_is_read() {
        let entry = DesktopEntry::parse(
            "# A comment\n\n[Other]\nName=Wrong\n[Desktop Entry]\r\nName = Text Editor \r\n  Exec=gedit %U\n#Name=Commented\nNoEquals\nName[es]=Editor de textos\nEmpty=\nTwice=first\nTwice=second\n\n[Desktop Action new-window]\nName=New Window\nExec=gedit --new-window\n",
        );
        assert_eq!(entry.string("Name").as_deref(), Some("Text Editor"));
        assert_eq!(entry.string("Exec").as_deref(), Some("gedit %U"));
        assert_eq!(
            entry.string("Name[es]").as_deref(),
            Some("Editor de textos")
        );
        assert_eq!(entry.string("Empty").as_deref(), Some(""));
        // As GLib: the later line replaces the earlier.
        assert_eq!(entry.string("Twice").as_deref(), Some("second"));
        assert_eq!(entry.string("NoEquals"), None);
        assert_eq!(
            DesktopEntry::parse("Name=No group"),
            DesktopEntry::default()
        );
        // A value keeps its own equals signs and inner spaces.
        let entry = DesktopEntry::parse("[Desktop Entry]\nExec=env A=b  run --x=1");
        assert_eq!(entry.string("Exec").as_deref(), Some("env A=b  run --x=1"));
    }

    #[test]
    fn values_are_unescaped() {
        let entry = DesktopEntry::parse(
            "[Desktop Entry]\nName=a\\sb\\nc\\td\\re\\\\f\\x\\\nList=one;two\\;2;three\\sand;\nOpen=one;two\nNone=\nFlag=true\nNot=True\nNo=false\n",
        );
        assert_eq!(
            entry.string("Name").as_deref(),
            Some("a b\nc\td\re\\f\\x\\")
        );
        assert_eq!(entry.list("List"), ["one", "two;2", "three and"]);
        assert_eq!(entry.list("Open"), ["one", "two"]);
        assert!(entry.list("None").is_empty());
        assert!(entry.list("Missing").is_empty());
        assert!(entry.boolean("Flag"));
        assert!(!entry.boolean("Not"));
        assert!(!entry.boolean("No"));
        assert!(!entry.boolean("Missing"));
    }

    #[test]
    fn names_follow_the_users_language() {
        let entry = DesktopEntry::parse(
            "[Desktop Entry]\nName=Files\nName[es]=Archivos\nName[es_CO]=Archivos (CO)\nName[sr@latin]=Datoteke\nName[sr]=Датотеке\nName[de]=\nComment[fr]=Seulement\n",
        );
        let named = |locales: &[&str]| entry.localized("Name", &strings(locales));
        assert_eq!(named(&["es_CO", "es"]).as_deref(), Some("Archivos (CO)"));
        assert_eq!(named(&["es_MX", "es"]).as_deref(), Some("Archivos"));
        assert_eq!(
            named(&["sr_RS@latin", "sr_RS", "sr@latin", "sr"]).as_deref(),
            Some("Datoteke")
        );
        assert_eq!(named(&["fr_FR", "fr"]).as_deref(), Some("Files"));
        assert_eq!(named(&[]).as_deref(), Some("Files"));
        // A translation that is there but empty is what the file says.
        assert_eq!(named(&["de"]), None);
        assert_eq!(entry.localized("Comment", &[]), None);
        assert_eq!(
            entry.localized("Comment", &strings(&["fr"])).as_deref(),
            Some("Seulement")
        );
    }

    #[test]
    fn the_environment_says_which_languages() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            locale_candidates(|name| {
                pairs
                    .iter()
                    .find(|(known, _)| *known == name)
                    .map(|(_, value)| value.to_string())
            })
        };
        assert_eq!(env(&[("LANG", "es_CO.UTF-8")]), ["es_CO", "es"]);
        assert_eq!(
            env(&[("LANG", "sr_RS.UTF-8@latin")]),
            ["sr_RS@latin", "sr_RS", "sr@latin", "sr"]
        );
        assert_eq!(env(&[("LANG", "ca@valencia")]), ["ca@valencia", "ca"]);
        assert_eq!(
            env(&[("LANG", "en_US.UTF-8"), ("LC_MESSAGES", "de_DE")]),
            ["de_DE", "de"]
        );
        assert_eq!(
            env(&[
                ("LANG", "en_US.UTF-8"),
                ("LC_MESSAGES", "de_DE"),
                ("LC_ALL", "fr")
            ]),
            ["fr"]
        );
        // An empty variable is not set.
        assert_eq!(env(&[("LC_ALL", ""), ("LANG", "pt_BR")]), ["pt_BR", "pt"]);
        assert_eq!(
            env(&[("LANG", "en_US.UTF-8"), ("LANGUAGE", "es_CO:es:en_US:en")]),
            ["es_CO", "es", "en_US", "en"]
        );
        // LANGUAGE means nothing without a language to begin with.
        assert!(env(&[("LANGUAGE", "es")]).is_empty());
        assert!(env(&[("LANG", "C.UTF-8"), ("LANGUAGE", "es")]).is_empty());
        assert!(env(&[("LANG", "POSIX")]).is_empty());
        assert!(env(&[]).is_empty());
    }

    #[test]
    fn a_launcher_shows_applications_meant_for_this_desktop() {
        let shown = |more: &str, desktops: &[&str]| {
            let text = format!("[Desktop Entry]\n{more}");
            DesktopEntry::parse(&text).is_shown(
                &strings(desktops),
                &[PathBuf::from("/bin"), PathBuf::from("/opt/bin")],
                &|path| path == Path::new("/opt/bin/tool") || path == Path::new("/abs/tool"),
            )
        };
        let app = "Type=Application\nName=App\nExec=app\n";
        assert!(shown(app, &[]));
        assert!(!shown("Name=App\nExec=app\n", &[]));
        assert!(!shown("Type=Link\nName=App\nExec=app\n", &[]));
        assert!(!shown("Type=Application\nExec=app\n", &[]));
        assert!(!shown("Type=Application\nName=App\n", &[]));
        assert!(!shown("Type=Application\nName=App\nExec=\n", &[]));
        assert!(!shown(&format!("{app}NoDisplay=true\n"), &[]));
        assert!(shown(&format!("{app}NoDisplay=false\n"), &[]));
        assert!(!shown(&format!("{app}Hidden=true\n"), &[]));
        assert!(shown(
            &format!("{app}OnlyShowIn=GNOME;KDE;\n"),
            &["ubuntu", "GNOME"]
        ));
        assert!(!shown(&format!("{app}OnlyShowIn=GNOME;KDE;\n"), &["XFCE"]));
        assert!(!shown(&format!("{app}OnlyShowIn=GNOME;\n"), &[]));
        // Shown nowhere.
        assert!(!shown(&format!("{app}OnlyShowIn=\n"), &["GNOME"]));
        assert!(!shown(&format!("{app}NotShowIn=KDE;GNOME\n"), &["GNOME"]));
        assert!(shown(&format!("{app}NotShowIn=KDE;\n"), &["GNOME"]));
        // Desktop names are compared as written.
        assert!(!shown(&format!("{app}OnlyShowIn=gnome;\n"), &["GNOME"]));
        assert!(shown(&format!("{app}TryExec=tool\n"), &[]));
        assert!(shown(&format!("{app}TryExec=/abs/tool\n"), &[]));
        assert!(!shown(&format!("{app}TryExec=other\n"), &[]));
        assert!(!shown(&format!("{app}TryExec=/bin/tool\n"), &[]));
        assert!(shown(&format!("{app}TryExec=\n"), &[]));
    }

    #[test]
    fn an_id_is_the_path_with_dashes() {
        let root = Path::new("/usr/share/applications");
        assert_eq!(
            desktop_file_id(root, &root.join("firefox.desktop")),
            "firefox.desktop"
        );
        assert_eq!(
            desktop_file_id(root, &root.join("kde/okular.desktop")),
            "kde-okular.desktop"
        );
        assert_eq!(
            desktop_file_id(root, &root.join("a/b/c.desktop")),
            "a-b-c.desktop"
        );
    }

    #[test]
    fn exec_lines_split_at_spaces() {
        assert_eq!(split("firefox"), ["firefox"]);
        assert_eq!(split("firefox %u"), ["firefox", "%u"]);
        assert_eq!(
            split("  env  A=b\tprog   --flag  "),
            ["env", "A=b", "prog", "--flag"]
        );
        assert!(split("").is_empty());
        assert!(split("   ").is_empty());
    }

    #[test]
    fn exec_quoting_follows_the_specification() {
        // Double quotes keep spaces; inside, a backslash keeps " ` $ and \.
        assert_eq!(
            split(r#""/opt/My App/run" --name "two words""#),
            ["/opt/My App/run", "--name", "two words"]
        );
        assert_eq!(
            split(r#"sh -c "echo \"hi\" \$HOME \`id\` \\ done""#),
            ["sh", "-c", r#"echo "hi" $HOME `id` \ done"#]
        );
        // Any other backslash inside quotes stays.
        assert_eq!(split(r#""a\nb\x""#), [r"a\nb\x"]);
        // Reserved characters are plain inside quotes.
        assert_eq!(
            split(r#""a 'b' > < ~ | & ; * ? # ( )""#),
            ["a 'b' > < ~ | & ; * ? # ( )"]
        );
        // Quotes join what they touch, and an empty pair is an argument.
        assert_eq!(split(r#"a"b c"d "" e"#), ["ab cd", "", "e"]);
        assert_eq!(split(r#"--title="My App""#), ["--title=My App"]);
        // As a shell: single quotes keep everything, a backslash outside
        // quotes keeps the next character.
        assert_eq!(
            split(r#"sh -c 'echo "$1" \n' x"#),
            ["sh", "-c", r#"echo "$1" \n"#, "x"]
        );
        assert_eq!(split(r"My\ App --a\\b \'q\'"), ["My App", r"--a\b", "'q'"]);
        assert_eq!(split("''"), [""]);
        assert_eq!(split(r"end\"), [r"end\"]);
        assert_eq!(split_exec(r#"run "unclosed"#), Err(UnclosedQuote));
        assert_eq!(split_exec("run 'unclosed"), Err(UnclosedQuote));
        assert_eq!(split_exec(r#"run "ends with\"#), Err(UnclosedQuote));
    }

    #[test]
    fn exec_is_unescaped_twice_as_the_specification_warns() {
        // The specification's own example: a literal dollar sign in a quoted
        // argument is written \\$ in the file, a backslash \\\\.
        let entry = DesktopEntry::parse(
            "[Desktop Entry]\nExec=prog \"a \\\\$ b\" \"c \\\\\\\\ d\" one\\stwo \"three\\sfour\"\n",
        );
        let exec = entry.string("Exec").unwrap();
        assert_eq!(exec, r#"prog "a \$ b" "c \\ d" one two "three four""#);
        assert_eq!(
            split(&exec),
            ["prog", "a $ b", r"c \ d", "one", "two", "three four"]
        );
    }

    fn fields() -> ExecFields {
        ExecFields {
            icon: Some("my-icon".into()),
            name: "Mi app".into(),
            file: "/usr/share/applications/my app.desktop".into(),
        }
    }

    fn expand(exec: &str) -> Vec<String> {
        expand_exec(&split(exec), &fields())
    }

    #[test]
    fn field_codes_for_files_stand_for_nothing() {
        assert_eq!(expand("gedit %U"), ["gedit"]);
        assert_eq!(expand("gedit %u"), ["gedit"]);
        assert_eq!(expand("gedit %F --new"), ["gedit", "--new"]);
        assert_eq!(expand("gedit %f"), ["gedit"]);
        assert_eq!(expand("prog --file=%f --go"), ["prog", "--file=", "--go"]);
        assert_eq!(expand(r#"prog "%f""#), ["prog"]);
    }

    #[test]
    fn field_codes_for_the_entry_are_filled_in() {
        assert_eq!(expand("prog %i"), ["prog", "--icon", "my-icon"]);
        assert_eq!(
            expand("prog -caption %c --desktop %k"),
            [
                "prog",
                "-caption",
                "Mi app",
                "--desktop",
                "/usr/share/applications/my app.desktop"
            ]
        );
        assert_eq!(expand("prog --title=%c!"), ["prog", "--title=Mi app!"]);
        assert_eq!(expand("prog 100%% %%f a%%"), ["prog", "100%", "%f", "a%"]);
        // Without an icon, %i is no argument at all.
        let bare = ExecFields {
            icon: None,
            ..fields()
        };
        assert_eq!(expand_exec(&split("prog %i %c"), &bare), ["prog", "Mi app"]);
        let empty = ExecFields {
            icon: Some(String::new()),
            ..fields()
        };
        assert_eq!(expand_exec(&split("prog %i"), &empty), ["prog"]);
        // Inside another argument it has no meaning.
        assert_eq!(expand("prog x%iy"), ["prog", "xy"]);
    }

    #[test]
    fn deprecated_and_unknown_field_codes_are_removed() {
        assert_eq!(expand("prog %d %D %n %N %v %m end"), ["prog", "end"]);
        assert_eq!(expand("prog %x a%zb %"), ["prog", "ab"]);
        assert_eq!(expand("prog 50%"), ["prog", "50"]);
        // An argument that is empty without any code stays.
        assert_eq!(expand(r#"prog "" x"#), ["prog", "", "x"]);
    }

    #[test]
    fn a_program_is_found_by_path_or_by_name() {
        let path = [PathBuf::from("/a"), PathBuf::from("/b")];
        let is_program = |file: &Path| file == Path::new("/b/tool") || file == Path::new("/x/y");
        assert_eq!(
            find_program("tool", &path, &is_program),
            Some(PathBuf::from("/b/tool"))
        );
        assert_eq!(find_program("other", &path, &is_program), None);
        assert_eq!(
            find_program("/x/y", &path, &is_program),
            Some(PathBuf::from("/x/y"))
        );
        assert_eq!(find_program("/x/z", &path, &is_program), None);
    }

    #[test]
    fn a_terminal_is_chosen_and_given_the_command() {
        let command = strings(&["htop", "-d", "5"]);
        let has = |names: &'static [&'static str]| move |name: &str| names.contains(&name);
        assert_eq!(
            find_terminal(None, &has(&["xterm", "konsole"])).as_deref(),
            Some("konsole")
        );
        assert_eq!(
            find_terminal(Some("xterm"), &has(&["xterm", "konsole"])).as_deref(),
            Some("xterm")
        );
        assert_eq!(
            find_terminal(Some("gone"), &has(&["foot"])).as_deref(),
            Some("foot")
        );
        assert_eq!(
            find_terminal(Some(""), &has(&["foot"])).as_deref(),
            Some("foot")
        );
        assert_eq!(find_terminal(Some("gone"), &has(&[])), None);
        assert_eq!(
            in_terminal("gnome-terminal", &command),
            ["gnome-terminal", "--", "htop", "-d", "5"]
        );
        assert_eq!(
            in_terminal("konsole", &command),
            ["konsole", "-e", "htop", "-d", "5"]
        );
        assert_eq!(in_terminal("kitty", &command), ["kitty", "htop", "-d", "5"]);
        assert_eq!(
            in_terminal("wezterm", &command),
            ["wezterm", "start", "--", "htop", "-d", "5"]
        );
        assert_eq!(
            in_terminal("/usr/bin/xfce4-terminal", &command),
            ["/usr/bin/xfce4-terminal", "-x", "htop", "-d", "5"]
        );
        assert_eq!(
            in_terminal("my-term", &command),
            ["my-term", "-e", "htop", "-d", "5"]
        );
    }
}
