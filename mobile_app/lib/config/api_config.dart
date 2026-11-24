import 'package:flutter/foundation.dart';

/// Backend connection settings.
///
/// Browser and desktop clients use host loopback. Android Emulator uses the
/// host alias. Physical Android devices must override this with the computer's
/// reachable LAN address using `--dart-define=API_BASE_URL=...`.
class ApiConfig {
  ApiConfig._();

  static const String _configuredBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
  );

  static String get baseUrl {
    if (_configuredBaseUrl.isNotEmpty) return _configuredBaseUrl;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:8000';
    }
    return 'http://127.0.0.1:8000';
  }

  static const Duration timeout = Duration(seconds: 15);
}
