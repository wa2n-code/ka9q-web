import sys
import os

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
brace = 0
paren = 0
brack = 0
line = 1
unmatched = []
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

    # Not in comment or string
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
        brace += 1
    elif ch == '}':
        if brace == 0:
            unmatched.append((line, '}', i))
        else:
            brace -= 1
    elif ch == '(':
        paren += 1
    elif ch == ')':
        if paren == 0:
            unmatched.append((line, ')', i))
        else:
            paren -= 1
    elif ch == '[':
        brack += 1
    elif ch == ']':
        if brack == 0:
            unmatched.append((line, ']', i))
        else:
            brack -= 1

print('braces:', brace, 'parens:', paren, 'brackets:', brack)
print('in_ml_comment:', in_ml, 'in_string:', in_str, 'in_char:', in_char)
if unmatched:
    print('\nUnmatched closing tokens:')
    for u in unmatched:
        print('line', u[0], 'token', u[1])

# Print last 60 lines for context
lines = s.splitlines()
print('\n--- Last 60 lines ---')
for L in lines[-60:]:
    print(L)
