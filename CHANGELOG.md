# Steelmesh Changelog

## 0.9.7

- Updated package deps to latest stable versions.
- Added worker death conditions when processes take too much memory.

## 0.9.1

- Fixed deployment dash plugin returning results when not all versions have been loaded.

## 0.9.0

- Replaced custom monitor logic with [ChangeMachine]()

## 0.8.9

- Moved from homegrown QueueProcessor in the monitor to using [neuron](https://github.com/flatiron/neuron).