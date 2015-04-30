module.exports = compile

var parse = require('./parser').parse
var es6toes5 = require('es6-destructuring').compile

function compile (code, opts) {
  var program = parse(code)

  var parts = []
  parts.push(generateHeader(opts))
  parts.push('')

  parts.push(generateStatic(opts))
  parts.push('')

  var constraints = {}
  var ruleNo = 1
  program.body.forEach(function (body) {
    if (body.type === 'PropagationRule' || body.type === 'SimplificationRule' || body.type === 'SimpagationRule') {
      if (!body.name) {
        body.name = '__rule_' + ruleNo
      }
      ruleNo++

      parts.push(translateRule(body, opts, constraints))
    }
  })

  parts.push(generateActivateProperties(opts, constraints))

  parts.push('module.exports = new CHR()')

  var generatedCode = parts.join('\n')

  if (!opts.es6) {
    generatedCode = es6toes5(generatedCode, opts).code
  }

  return generatedCode
}

function translateRule (rule, opts, constraints) {
  var parts = []

  rule.constraints.forEach(function (functor) {
    var name = functor.replace(/^(.+)\/.+$/, '$1')
    if (!constraints.hasOwnProperty(name)) {
      constraints[name] = {
        occurences: {}
      }

      parts.push(generateConstraintProperty(opts, name))
      parts.push('')
    }
  })

  parts.push(generateOccurenceProperties(opts, rule, constraints))

  return parts.join('\n')
}

function generateHeader (opts) {
  return [
    'var Store = require("chr/runtime/store")',
    'var History = require("chr/runtime/history")',
    'var Constraint = require("chr/runtime/constraint")'
  ].join('\n')
}

function generateStatic (opts) {
  return [
    indent(0) + 'function allDifferent(arr) {',
    indent(1) + 'return arr.every(function(el1, ix) {',
    indent(2) + 'return arr.slice(ix+1).every(function(el2) {',
    indent(3) + 'return el1 != el2',
    indent(2) + '})',
    indent(1) + '})',
    indent(0) + '}',
    indent(0),
    indent(0) + 'function CHR() {',
    indent(1) + 'this.Store = new Store()',
    indent(2) + 'this.History = new History()',
    indent(0) + '}'
  ].join('\n')
}

function generateConstraintProperty (opts, name) {
  return [
    indent(0) + 'CHR.prototype.' + name + ' = function ' + name + '() {',
    indent(1) + 'var args = Array.prototype.slice.call(arguments)',
    indent(1) + 'var arity = arguments.length',
    indent(1),
    indent(1) + 'var callConstraint = "_' + name + '_"+arity+"_activate"',
    indent(1) + 'if (!this[callConstraint]) {',
    indent(2) + 'throw new Error("Constraint ' + name + '/"+arity+" not defined.")',
    indent(1) + '}',
    indent(1),
    indent(1) + 'var constraint = new Constraint("' + name + '", arity, args)',
    indent(1) + 'this.Store.add(constraint)',
    indent(1) + 'this[callConstraint](constraint)',
    indent(1),
    indent(1) + 'return this',
    indent(0) + '}'
  ].join('\n')
}

function generateActivateProperties (opts, constraints) {
  var parts = []

  for (var constraintName in constraints) {
    for (var arity in constraints[constraintName].occurences) {
      parts.push('CHR.prototype._' + constraintName + '_' + arity + '_activate = function (constraint) {')
      for (var i = 1; i < constraints[constraintName].occurences[arity]; i++) {
        parts.push(indent(1) + 'this._' + constraintName + '_' + arity + '_occurence_' + i + '(constraint)')
      }
      parts.push([
        '}',
        ''
      ].join('\n'))
    }
  }

  return parts.join('\n')
}

function generateOccurenceProperties (opts, rule, constraints) {
  var parts = []

  var curr
  for (var i = rule.head.length - 1; i >= 0; i--) {
    // loop from right to left

    curr = rule.head[i]
    if (curr.type !== 'Constraint') {
      continue
    }

    var occurenceNumber = 1
    if (constraints[curr.name].occurences.hasOwnProperty(curr.arity)) {
      occurenceNumber = constraints[curr.name].occurences[curr.arity]
    }

    parts.push([
      'CHR.prototype._' + curr.name + '_' + curr.arity + '_occurence_' + occurenceNumber + ' = function (constraint) {',
      '  var self = this',
      '  '
    ].join('\n'))

    if (curr.arity > 0) {
      // destructuring variables
      parts.push([
        indent(1) + destructuring(curr, 'constraint.args'),
        indent(1)
      ].join('\n'))
    }

    var j
    var level = 1
    var ids = []
    for (j = 0; j < rule.head.length; j++) {
      if (j === i) {
        ids.push('constraint.id')
        continue
      }

      ids.push('id' + (j + 1))

      parts.push(indent(level) + 'self.Store.lookup("' + rule.head[j].name + '", ' + rule.head[j].arity + ').forEach(function (id' + (j + 1) + ') {')
      level++

      parts.push([
        'if (!self.Store.alive(id' + (j + 1) + ')) {',
        indent(1) + 'return',
        '}'
      ].map(indentBy(level)).join('\n'))

      if (rule.head[j].arity > 0) {
        parts.push(indent(level) + destructuring(rule.head[j], 'self.Store.args(id' + (j + 1) + ')'))
      }

      parts.push(indent(level))
    }

    parts.push([
      'var ids = [ ' + ids.join(', ') + ' ]',
      'if (ids.every(function(id) { return self.Store.alive(id) })) {',
      indent(1) + 'if (allDifferent(ids)) {'
    ].map(indentBy(level)).join('\n'))
    level += 2

    if (rule.guard.length > 0) {
      parts.push(indent(level) + generateGuards(opts, rule))
      level += 1
    }

    parts.push([
      'if (self.History.notIn("' + rule.name + '", ids)) {',
      indent(1) + 'self.History.add("' + rule.name + '", ids)',
      ''
    ].map(indentBy(level)).join('\n'))

    level += 1

    for (var k = rule.r + 1; k <= rule.head.length; k++) {
      // remove constraints
      parts.push(indent(level) + 'self.Store.kill(ids[' + (k - 1) + '])')
    }

    if (rule.body.length > 0) {
      parts.push(rule.body.map(function (body) {
        return generateTell(opts, body)
      }).map(indentBy(level)).join('\n'))
    }

    level -= 1

    parts.push(indent(level) + '}')

    if (rule.guard.length > 0) {
      level -= 1
      parts.push(indent(level) + '}')
    }

    level -= 2
    parts.push([
      indent(1) + '}',
      '}'
    ].map(indentBy(level)).join('\n'))

    for (j = rule.head.length - 1; j >= 0; j--) {
      if (j === i) {
        continue
      }

      level--
      parts.push(indent(level) + '})')
    }

    parts.push([
      '}',
      ''
    ].join('\n'))

    constraints[curr.name].occurences[curr.arity] = occurenceNumber + 1
  }

  return parts.join('\n')
}

function generateGuards (opts, rule) {
  var expr = 'if ('
  expr += rule.guard.map(function (guard) {
    return generateGuard(opts, guard)
  }).join(' && ')
  expr += ') {'
  return expr
}

function generateGuard (opts, guard) {
  if (guard.type === 'BinaryExpression') {
    return generateBinaryExpression(opts, guard)
  }

  return 'false'
}

function generateBinaryExpression (opts, expr) {
  return [ 'left', 'right' ].map(function (part) {
    if (expr[part].type === 'Identifier') {
      return expr[part].name
    }
    if (expr[part].type === 'Literal') {
      return expr[part].value
    }
    if (expr[part].type === 'BinaryExpression') {
      return '(' + generateBinaryExpression(opts, expr[part]) + ')'
    }
  }).join(' ' + expr.operator + ' ')
}

function generateTell (opts, body) {
  var expr = ''
  if (body.type === 'Constraint') {
    expr += 'self.' + body.name + '('
    expr += body.parameters.map(function (parameter) {
      return generateExpression(opts, parameter)
    }).join(', ')
    expr += ')'
    return expr
  }

  expr += [
    'if (!(' + generateBinaryExpression(opts, body) + ')) {',
    indent(1) + 'self.Store.invalidate()',
    indent(1) + 'return',
    '}'
  ].join('\n')
  return expr
}

function generateExpression (opts, parameter) {
  if (parameter.type === 'Identifier') {
    return parameter.name
  }
  if (parameter.type === 'BinaryExpression') {
    return generateBinaryExpression(opts, parameter)
  }
}

function indent (level, spaces) {
  level = level || 0
  spaces = spaces || 2

  return Array(level * spaces + 1).join(' ')
}

function indentBy (level, spaces) {
  return function (str) {
    return indent(level, spaces) + str
  }
}

function destructuring (constraint, to) {
  var expr = 'var [ '
  expr += constraint.parameters.map(function (parameter) {
    return parameter.name
  }).join(', ')
  expr += ' ] = ' + to

  return expr
}
