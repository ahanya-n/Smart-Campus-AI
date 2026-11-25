/// Backend connection settings.
///
/// Browser and desktop clients use host loopback. Physical Android devices use
/// host loopback with `adb reverse`; Android Emulator builds can override this
/// with `--dart-define=API_BASE_URL=http://10.0.2.2:8000`.
class ApiConfig {
  ApiConfig._();

  static const String _configuredBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
  );

  static String get baseUrl {
    if (_configuredBaseUrl.isNotEmpty) return _configuredBaseUrl;
    return 'http://127.0.0.1:8000';
  }

  static const Duration timeout = Duration(seconds: 15);
}
