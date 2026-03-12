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
ops = []
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
        ops.append((line, '{', len(stack)))
    elif ch == '}':
        if stack:
            opened = stack.pop()
            ops.append((line, '}', len(stack)))
        else:
            ops.append((line, '}', -1))

# Print last 200 ops
print('Total ops:', len(ops))
for op in ops[-200:]:
    print('line', op[0], op[1], 'depth', op[2])

print('\nRemaining stack size:', len(stack))
if stack:
    for ln, idx in stack:
        print('Unclosed at line', ln)
