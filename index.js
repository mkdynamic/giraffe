// data must be rows of (TIME_FMT VALUE), gaps allowed, unsorted
var parse = function(opts) {
  var raw = opts.raw;
  var timeFmt = opts.timeFmt;
  var parseTime = d3.timeParse(timeFmt);
  var idxs = opts.idxs;

  return raw.split(/\n+/).map(function(line) {
    var cols = line.split(/\s+/);
    return {
      t: parseTime(cols[idxs.time]),
      v: parseFloat(cols[idxs.value])
    };
  });
};

// data must be [{t:Date,v:x.x,...}], gaps allowed, unsorted
var computeFilledData = function(opts) {
  var data = opts.data;
  var fillMode = opts.fillMode;
  var tInterval = opts.interval;

  var tData = data.map(function(d) { return d.t; });
  var tMin = d3.min(tData);
  var tMax = d3.max(tData);
  var tStep = tInterval.every(1);
  var tRange = tStep.range(tMin, tInterval.offset(tMax, 1));

  var dataByTs = data.reduce(function(m, d) {
    m[d.t.getTime()] = d;
    return m;
  }, {});

  return tRange.reduce(function(m, t) {
    var d = dataByTs[t.getTime()];
    if (d) return m.concat(d);

    switch (fillMode) {
      case 'zero':
        return m.concat({ t: t, v: 0 });
      case 'last-non-blank-or-zero':
        return m.concat({ t: t, v: (m.length > 0 ? m[m.length - 1].v : 0) });
      case 'omit':
        return m.concat({ t: t });
    }
  }, []);
};

// data must be [{t:Date,v:x.x,...}], no gaps, sorted
var computeAnalyzedData = function(opts) {
  var data = opts.data;
  var analysis = opts.analysis;

  var analyzers = {
    sma: {
      filterData: function(opts, data) {
        return data.filter(function(d) { return typeof d.v !== 'undefined'; });
      },
      prepareInput: function(opts, data, idx) {
        return data
          .slice(Math.max(0, idx + 1 - opts.windowSize), idx + 1)
          .map(function(d) { return d.v; });
      },
      computeOutput: function(opts, vs) {
        if (vs.length < opts.windowSize) return false;
        return d3.mean(vs);
      }
    },
    ema: {
      filterData: function(opts, data) {
        return data.filter(function(d) { return typeof d.v !== 'undefined'; });
      },
      prepareInput: function(opts, data, idx) {
        return data
          .slice(0, idx + 1)
          .map(function(d) { return d.v; })
          .reverse();
      },
      computeOutput: function(opts, vs) {
        if (vs.length < opts.windowSize) return false;
        var a = 2 / (1 + opts.windowSize);
        var coeffs = vs.map(function(_x, idx) { return Math.pow(1 - a, idx); });
        var num = vs.reduce(function(m, x, idx) { return m + coeffs[idx] * x; }, 0);
        var den = coeffs.reduce(function(m, x) { return m + x; }, 0);
        return num / den;
      }
    }
  };

  var analyze = function(analyzer, opts, data) {
    var dataFiltered = analyzer.filterData(opts, data);
    return dataFiltered.reduce(function(m, d, idx) {
      var input = analyzer.prepareInput(opts, dataFiltered, idx);
      var vAnalyzed = analyzer.computeOutput(opts, input);
      if (vAnalyzed === false) return m;
      return m.concat({ t: d.t, v: vAnalyzed });
    }, []);
  };

  return analyze(analyzers[analysis.type], analysis.opts, data);
};

var drawChart = function(opts) {
  // reset
  document.querySelectorAll('.artboard svg').forEach(function(el) { el.remove(); });

  var plotType = 'analyzed';

  var series = opts.series;
  var artboard = opts.artboard;
  var artboardStyle = getComputedStyle(artboard, null);
  var paddingH = parseFloat(artboardStyle.getPropertyValue('padding-left')) +
    parseFloat(artboardStyle.getPropertyValue('padding-right'));
  var paddingV = parseFloat(artboardStyle.getPropertyValue('padding-top')) +
    parseFloat(artboardStyle.getPropertyValue('padding-bottom'));
  var width = artboard.clientWidth - paddingH;
  var height = artboard.clientHeight - paddingV;
  var allData = series.reduce(function(m, s) { return m.concat(s[plotType]); }, []);
  var yExtentAuto = d3.extent(allData, function(d) { return d.v; });
  var yExtent = [
    opts.yExtent[0] === 'auto' ? yExtentAuto[0] : opts.yExtent[0],
    opts.yExtent[1] === 'auto' ? yExtentAuto[1] : opts.yExtent[1]
  ];

  var x = d3.scaleTime()
    .range([0, width])
    .domain(d3.extent(allData, function(d) { return d.t; }));

  var y = d3.scaleLinear()
    .range([height, 0])
    .domain(yExtent);

  var line = d3.line()
    .x(function(d) { return x(d.t); })
    .y(function(d) { return y(d.v); });

  var svg = d3.select(artboard)
    .append('svg');

  svg.append('g')
    .attr('class', 'axis axis-x')
    .attr('transform', 'translate(0,' + height + ')')
    .call(d3.axisBottom(x).tickSizeInner(-height).tickSizeOuter(0).tickPadding(10).ticks(24));

  svg.append('g')
    .attr('class', 'axis axis-y')
    .call(d3.axisLeft(y).tickSizeInner(-width).tickSizeOuter(0).tickPadding(10));

  series.forEach(function(s, idx) {
    svg.append('path')
      .datum(s[plotType])
      .attr('class', 'line line-analysis line-' + idx)
      .attr('d', line);

    svg.append('path')
      .datum(s.original)
      .attr('class', 'line line-original line-' + idx)
      .attr('d', line);
  });
};

var drawResults = function(opts) {
  var series = opts.series;
  var table = opts.table;

  var plots = ['original', 'filled', 'analyzed'];
  var numCols = 1 + series.length * plots.length; // date, series1.original, series1.filled, series1.analyzed, ...
  var basisRange = series[0].filled; // assume all filled ranges the same
  var rowsByTs = basisRange.reduce(function(m, d) {
    var ts = d.t.getTime();
    m[ts] = new Array(numCols);
    m[ts][0] = d.t;
    return m;
  }, {}); // { ts1: [row_data], ... }

  series.forEach(function(s, idx) {
    for (var jdx = 0; jdx < plots.length; jdx++) {
      var colIdx = 1 + (idx * 3) + jdx;
      var plot = plots[jdx];
      s[plot].forEach(function(d) { rowsByTs[d.t.getTime()][colIdx] = d.v; });
    }
  });

  var buildTableRow = function(cells, isHeader) {
    var buffer = '<tr>';
    var cellType = isHeader ? 'th' : 'td';
    for (var idx = 0; idx < cells.length; idx++) {
      var v = '–';
      if (typeof cells[idx] === 'number') {
        v = cells[idx].toFixed(2);
      } else if (typeof cells[idx] === 'object' && cells[idx].toISOString) {
        v = cells[idx].toISOString();
      } else if (typeof cells[idx] !== 'undefined') {
        v = cells[idx].toString();
      }
      buffer += '<' + cellType + '>' + v + '</' + cellType + '>';
    }
    buffer += '</tr>';
    return buffer;
  };

  var html = '';

  var headers = [];
  for (var idx = 0; idx < numCols; idx++) {
    var seriesIdx = Math.floor((idx - 1) / plots.length);
    var plotIdx = (idx - 1) % plots.length;
    headers.push(idx === 0 ? 't' : (plots[plotIdx] + '.' + seriesIdx));
  }
  html += buildTableRow(headers, true);

  for (var ts in rowsByTs) {
    var row = rowsByTs[ts];
    html += buildTableRow(row);
  }

  table.innerHTML = html;
};


var render = function(dataElement) {
  var series = [];

  var valueIdxs = document.querySelector('#idx-values').value.split(',')
    .map(function(v) { return parseInt(v, 10); });

  valueIdxs.forEach(function(valueIdx) {
    var data = parse({
      raw: document.querySelector('#data').value,
      timeFmt: document.querySelector('#time-fmt').value,
      idxs: {
        time: parseInt(document.querySelector('#idx-time').value, 10),
        value: valueIdx
      }
    });

    var dataFilled = computeFilledData({
      data: data,
      fillMode: document.querySelector('#fill-mode').options[document.querySelector('#fill-mode').selectedIndex].value,
      interval: d3[document.querySelector('#interval').options[document.querySelector('#interval').selectedIndex].value]
    });

    var dataAnalyzed = computeAnalyzedData({
      data: dataFilled,
      analysis: {
        type: document.querySelector('#analysis').options[document.querySelector('#analysis').selectedIndex].value,
        opts: { windowSize: parseInt(document.querySelector('#window-size').value, 10) }
      }
    });

    series.push({ original: data, filled: dataFilled, analyzed: dataAnalyzed });
  });

  drawResults({
    series: series,
    table: document.querySelector('.results')
  });

  drawChart({
    series: series,
    artboard: document.querySelector('.artboard'),
    yExtent: document.querySelector('#extent-y').value.split(',').map(function(v) {
      if (v === 'auto') {
        return v;
      } else {
        return parseFloat(v);
      }
    })
  });
};

document.getElementById('render').addEventListener('click', function() {
  render();
});
