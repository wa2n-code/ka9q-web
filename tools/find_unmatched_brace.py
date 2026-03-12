import sys, os
path = r"c:\Users\wayne\Dev\ka9q-web\ka9q-web.c"
if not os.path.exists(path):
    print('File not found:', path)
    sys.exit(1)

s = open(path, 'rb').read().decode('utf-8', errors='replace')

in_ml = False
in_sl = False
in_str = False
in_char = False
escape = False
stack = []
line = 1
for i,ch in enumerate(s):
    if ch == '\n':
        line += 1
        in_sl = False
        escape = False
        continue
    if in_sl:
        continue
    if in_ml:
        if ch == '*' and i+1 < len(s) and s[i+1] == '/':
            in_ml = False
        continue
    if in_str:
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == '"':
            in_str = False
        continue
    if in_char:
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == "'":
            in_char = False
        continue

    if ch == '/' and i+1 < len(s) and s[i+1] == '/':
        in_sl = True
        continue
    if ch == '/' and i+1 < len(s) and s[i+1] == '*':
        in_ml = True
        continue
    if ch == '"':
        in_str = True
        continue
    if ch == "'":
        in_char = True
        continue

    if ch == '{':
        stack.append((line, i))
    elif ch == '}':
        if stack:
            stack.pop()
        else:
            print('Unmatched closing brace at line', line)

if stack:
    print('Unmatched opening braces (not closed):')
    for ln, idx in stack:
        print('  line', ln)
else:
    print('All braces matched')

# Show snippet around the first unmatched opening brace if any
if stack:
    ln, idx = stack[-1]
    lines = s.splitlines()
    start = max(0, ln-6)
    end = min(len(lines), ln+6)
    print('\nContext around last unmatched opening brace (lines %d-%d):' % (start+1, end))
    for i in range(start, end):
        pref = '>' if i == ln-1 else ' '
        print(f"{pref} {i+1:5d}: {lines[i]}")
