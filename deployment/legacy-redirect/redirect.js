(function () {
  'use strict';
  const destination = '/sports/' + location.search + location.hash;
  const link = document.getElementById('sports-link');
  if (link) link.href = destination;
  location.replace(destination);
})();
