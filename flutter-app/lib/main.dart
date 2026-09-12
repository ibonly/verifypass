import 'package:flutter/material.dart';
import 'screens/home_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const VerifyPassSampleApp());
}

class VerifyPassSampleApp extends StatelessWidget {
  const VerifyPassSampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    const primaryColor = Color(0xFF6D28D9);

    return MaterialApp(
      title: 'VerifyPass Sample',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: primaryColor,
          primary: primaryColor,
          surface: Colors.white,
        ),
        scaffoldBackgroundColor: const Color(0xFFF9FAFB),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF111827),
          foregroundColor: Colors.white,
          elevation: 0,
        ),
      ),
      home: const HomeScreen(),
    );
  }
}
