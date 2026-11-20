/// Backend connection settings.
///
/// The loopback default is for USB-connected devices using `adb reverse`.
/// Android Emulator must use the host alias:
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8000
class ApiConfig {
  ApiConfig._();

  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://127.0.0.1:8000',
  );

  static const Duration timeout = Duration(seconds: 15);
}
