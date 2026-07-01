# bash completion for cssgrep. Keep the flag list in sync with the USAGE string
# in index.js. Install: `source` this file from your ~/.bashrc, or drop it into
# your bash-completion completions directory renamed to `cssgrep`.
_cssgrep() {
    local cur prev opts
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    opts="-r --recursive --ext -i --ignore --ignore-file -n --line-number \
-p --print --attr --text --json --parent -w --max-width \
-A --after-context -B --before-context -C --context \
-m --max-count -M --max-total -c --count \
-l --files-with-matches -L --files-without-match -q --quiet -0 --null \
-H --with-filename --no-filename \
--color -h --help -V --version"

    case "$prev" in
        --color)
            COMPREPLY=( $(compgen -W "auto always never" -- "$cur") )
            return 0
            ;;
        --ignore-file)
            COMPREPLY=( $(compgen -f -- "$cur") )
            return 0
            ;;
        --ext|-i|--ignore|--attr|--parent|-w|--max-width|-A|--after-context|\
-B|--before-context|-C|--context|-m|--max-count|-M|--max-total)
            # value-taking flag with no enumerable completion; offer nothing
            return 0
            ;;
    esac

    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
        return 0
    fi

    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
}
complete -F _cssgrep cssgrep
